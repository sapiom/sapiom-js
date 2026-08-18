import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  createSdkMcpServer,
  query as agentSdkQuery,
  tool,
  type McpSdkServerConfigWithInstance,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  MANAGED_AGENT_CONTRACT,
  MANAGED_AGENT_L1_CERTIFICATION_CONTRACT,
  validateManagedAgentProbeConfig,
} from "./contract.js";
import { buildManagedAgentChildEnvironment } from "./environment.js";
import { ManagedAgentEventError, ManagedAgentEventRecorder } from "./events.js";
import {
  captureManagedAgentWorkspaceSnapshot,
  diffManagedAgentWorkspaceSnapshots,
  observeManagedAgentL1FinalBytes,
  observeManagedAgentPreservation,
} from "./fixture.js";
import {
  MANAGED_AGENT_BUILTIN_TOOLS,
  MANAGED_AGENT_DISALLOWED_TOOLS,
  createManagedAgentPolicyBoundary,
  type ManagedAgentPreToolUseGuardRejection,
} from "./permissions.js";
import { createLocalManagedAgentProcessObserver } from "./process-observer.js";
import {
  assertManagedAgentHooksEnabled,
  buildManagedAgentSettingsGuardEnvironment,
} from "./settings-guard.js";
import type {
  ManagedAgentProbeConfig,
  ManagedAgentProbeDependencies,
  ManagedAgentPolicyDiagnostic,
  ManagedAgentProbeResult,
  ManagedAgentQuery,
  ManagedAgentQueryExecutionOutcome,
  ManagedAgentTeardownObservation,
  ManagedAgentTeardownDeadline,
  ManagedAgentTerminalClassification,
  ManagedAgentToolEvidence,
} from "./types.js";

export const MANAGED_AGENT_MCP_SERVER_NAME = "sapiom-managed-agent-spike";
export const MANAGED_AGENT_TEARDOWN_TIMEOUT_MS = 5_000;
export const MANAGED_AGENT_CORRELATION_MARKER_VERSION =
  "SAPIOM_CERTIFICATION_CORRELATION_V1";
const QUERY_CLOSE_TIMEOUT_MS = 2_000;
const FORCE_CLEANUP_CONFIRMATION_RESERVE_MS = 1_000;
const MANAGED_AGENT_L2_BUILTIN_TOOLS = ["Bash"] as const;
const MANAGED_AGENT_L2_DISALLOWED_TOOLS = [
  ...MANAGED_AGENT_DISALLOWED_TOOLS,
  "Read",
  "Edit",
  "Write",
] as const;

type McpToolName = "echo_nonce" | "fail_once";

export interface ManagedAgentMcpRuntime {
  readonly server: McpSdkServerConfigWithInstance;
  readonly qualifiedToolNames: readonly string[];
  readonly invocations: readonly ManagedAgentToolEvidence[];
  readonly handlers: {
    readonly echoNonce: (input: { readonly nonce: string }) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
    readonly failOnce: () => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
  };
}

export function qualifiedManagedAgentMcpToolName(name: McpToolName): string {
  return `mcp__${MANAGED_AGENT_MCP_SERVER_NAME}__${name}`;
}

export function createManagedAgentMcpRuntime(
  expectedEchoNonce?: string,
): ManagedAgentMcpRuntime {
  const invocations: ManagedAgentToolEvidence[] = [];
  let failOnceCalls = 0;
  const nonceSchema = { nonce: z.string().min(1).max(256) };
  const handlers = {
    async echoNonce({ nonce }: { readonly nonce: string }) {
      const matched =
        expectedEchoNonce === undefined || nonce === expectedEchoNonce;
      invocations.push({
        toolName: qualifiedManagedAgentMcpToolName("echo_nonce"),
        status: matched ? ("success" as const) : ("error" as const),
      });
      return matched
        ? { content: [{ type: "text" as const, text: nonce }] }
        : {
            content: [
              {
                type: "text" as const,
                text: "nonce did not match the untracked-file sentinel",
              },
            ],
            isError: true,
          };
    },
    async failOnce() {
      failOnceCalls += 1;
      const failed = failOnceCalls === 1;
      invocations.push({
        toolName: qualifiedManagedAgentMcpToolName("fail_once"),
        status: failed ? ("error" as const) : ("success" as const),
      });
      return failed
        ? {
            content: [
              {
                type: "text" as const,
                text: "planned managed-agent probe failure; retry once",
              },
            ],
            isError: true,
          }
        : {
            content: [
              {
                type: "text" as const,
                text: "planned managed-agent probe recovery succeeded",
              },
            ],
          };
    },
  };
  const echoNonce = tool(
    "echo_nonce",
    "Return the supplied nonce exactly for the local managed-agent probe.",
    nonceSchema,
    handlers.echoNonce,
    { alwaysLoad: true },
  );
  const failOnce = tool(
    "fail_once",
    "Return a planned error once, then succeed on the next call.",
    nonceSchema,
    handlers.failOnce,
    { alwaysLoad: true },
  );
  return {
    server: createSdkMcpServer({
      name: MANAGED_AGENT_MCP_SERVER_NAME,
      version: "0.1.0",
      instructions:
        "These tools exist only for deterministic Sapiom local managed-agent feasibility probes.",
      tools: [echoNonce, failOnce],
      alwaysLoad: true,
    }),
    qualifiedToolNames: [
      qualifiedManagedAgentMcpToolName("echo_nonce"),
      qualifiedManagedAgentMcpToolName("fail_once"),
    ],
    invocations,
    handlers,
  };
}

function defaultQueryFactory(input: {
  readonly prompt: string;
  readonly options: Options;
}): ManagedAgentQuery {
  // The narrow return type intentionally withholds control-channel methods,
  // especially Query.mcpCall(), because those calls bypass permission checks.
  return agentSdkQuery(input);
}

function safeEvalSource(
  scenario: string,
  target: string,
  executionId: string,
): string {
  return `studio-managed-agent-e0-${scenario}-${target}-${executionId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildManagedAgentCorrelationPrompt(input: {
  readonly prompt: string;
  readonly evalSource: string;
  readonly executionId: string;
}): string {
  const marker = [
    MANAGED_AGENT_CORRELATION_MARKER_VERSION,
    `eval_source=${input.evalSource}`,
    `execution_id=${input.executionId}`,
  ].join(";");
  return [
    marker,
    "This is a non-secret certification marker. Do not repeat it.",
    input.prompt,
  ].join("\n");
}

function hasUniversalPolicyHookCoverage(
  toolEvidence: readonly ManagedAgentToolEvidence[],
  permissionEvidence: ManagedAgentProbeResult["permissionEvidence"],
): boolean {
  const requested = toolEvidence.filter(({ status }) => status === "requested");
  const requestedIds = requested.flatMap(({ toolUseId }) =>
    toolUseId ? [toolUseId] : [],
  );
  if (
    requestedIds.length !== requested.length ||
    new Set(requestedIds).size !== requestedIds.length
  ) {
    return false;
  }
  return requestedIds.every((toolUseId) => {
    return (
      permissionEvidence.filter(
        (evidence) =>
          evidence.toolUseId === toolUseId &&
          evidence.source === "pre_tool_use",
      ).length === 1
    );
  });
}

function buildManagedAgentPolicyDiagnostics(
  toolEvidence: readonly ManagedAgentToolEvidence[],
  permissionEvidence: ManagedAgentProbeResult["permissionEvidence"],
  guardRejections: readonly ManagedAgentPreToolUseGuardRejection[],
): ManagedAgentPolicyDiagnostic[] {
  const requestedIds = new Set(
    toolEvidence.flatMap(({ status, toolUseId }) =>
      status === "requested" && toolUseId ? [toolUseId] : [],
    ),
  );
  const diagnostics: ManagedAgentPolicyDiagnostic[] = guardRejections.map(
    ({ reason, toolName, normalizedToolUseId }) => ({
      kind: "pre_tool_use_guard_rejection",
      reason,
      toolName,
      correlatedRequest:
        normalizedToolUseId !== undefined &&
        requestedIds.has(normalizedToolUseId),
    }),
  );
  const primaryDecisionIds = new Set(
    permissionEvidence.flatMap(({ toolUseId, source }) =>
      source === "pre_tool_use" ? [toolUseId] : [],
    ),
  );
  const guardedRequestIds = new Set(
    guardRejections.flatMap(({ normalizedToolUseId }) =>
      normalizedToolUseId ? [normalizedToolUseId] : [],
    ),
  );
  for (const evidence of toolEvidence) {
    if (
      evidence.status !== "requested" ||
      !evidence.toolUseId ||
      primaryDecisionIds.has(evidence.toolUseId) ||
      guardedRequestIds.has(evidence.toolUseId)
    ) {
      continue;
    }
    diagnostics.push({
      kind: "missing_pre_tool_use_callback",
      reason: "no_callback_observed",
      toolName: evidence.toolName,
      correlatedRequest: true,
    });
  }
  return diagnostics;
}

async function closeQueryBounded(
  query: ManagedAgentQuery,
  iterator: AsyncIterator<unknown> | undefined,
  deadline: ManagedAgentTeardownDeadline,
  monotonicNow: () => number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  let closeResult: void | Promise<void>;
  try {
    closeResult = query.close();
  } catch {
    return false;
  }
  const closeWasAwaitable =
    closeResult !== undefined &&
    closeResult !== null &&
    typeof (closeResult as PromiseLike<void>).then === "function";
  const closeSettled = Promise.resolve(closeResult).then(
    () => true,
    () => false,
  );
  const cleanupSettled =
    typeof query.return === "function"
      ? Promise.resolve()
          .then(() => query.return!())
          .then(
            () => true,
            () => false,
          )
      : typeof iterator?.return === "function"
        ? Promise.resolve()
            .then(() => iterator.return!())
            .then(
              () => true,
              () => false,
            )
        : closeWasAwaitable
          ? closeSettled
          : new Promise<boolean>(() => undefined);
  const close = Promise.all([closeSettled, cleanupSettled]).then((settled) =>
    settled.every(Boolean),
  );
  const timeoutMs = Math.max(
    0,
    deadline.deadlineAtMs -
      monotonicNow() -
      FORCE_CLEANUP_CONFIRMATION_RESERVE_MS,
  );
  if (timeoutMs <= 0) {
    void close;
    return false;
  }
  try {
    return await Promise.race([
      close,
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(
          () => resolveTimeout(false),
          Math.min(QUERY_CLOSE_TIMEOUT_MS, timeoutMs),
        );
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForTaskBounded(
  task: Promise<void>,
  deadline: ManagedAgentTeardownDeadline,
  monotonicNow: () => number,
): Promise<boolean> {
  const timeoutMs = Math.max(0, deadline.deadlineAtMs - monotonicNow());
  if (timeoutMs <= 0) return false;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type ManagedAgentIteratorStep =
  | { readonly kind: "next"; readonly value: IteratorResult<unknown> }
  | { readonly kind: "aborted" };

async function nextManagedAgentEvent(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<ManagedAgentIteratorStep> {
  if (signal.aborted) return { kind: "aborted" };
  let abortListener: (() => void) | undefined;
  const next = Promise.resolve()
    .then(() => iterator.next())
    .then(
      (value): ManagedAgentIteratorStep => ({ kind: "next", value }),
      (error): ManagedAgentIteratorStep => {
        throw error;
      },
    );
  const aborted = new Promise<ManagedAgentIteratorStep>((resolveAbort) => {
    abortListener = () => resolveAbort({ kind: "aborted" });
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    // `next` converts a late rejection into this already-observed promise, so
    // abandoning it after abort cannot create an unhandled rejection.
    return await Promise.race([next, aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function classifyTerminal(input: {
  readonly teardown: ManagedAgentTeardownObservation;
  readonly queryCreated: boolean;
  readonly queryClosed: boolean;
  readonly cancellationRequested: boolean;
  readonly queryFailed: boolean;
  readonly sdkResult?: { readonly isError: boolean; readonly subtype?: string };
}): ManagedAgentTerminalClassification {
  if (!input.teardown.quiescent || !input.teardown.deadlineMet) {
    return "teardown_timeout";
  }
  if (input.queryCreated && !input.queryClosed) return "close_timeout";
  if (input.cancellationRequested) return "cancelled";
  if (input.queryFailed) return "query_error";
  if (input.sdkResult?.isError) return "sdk_result_error";
  if (input.sdkResult) return "success";
  return "incomplete";
}

function deepFreezeEvidence<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreezeEvidence(nested, seen);
  }
  return Object.freeze(value);
}

export async function runManagedAgentProbe(
  config: ManagedAgentProbeConfig,
  dependencies: ManagedAgentProbeDependencies = {},
): Promise<ManagedAgentProbeResult> {
  if (dependencies.hermeticGatewayOrigin && !dependencies.queryFactory) {
    throw new Error("hermeticGatewayOrigin requires an injected queryFactory");
  }
  const validated = validateManagedAgentProbeConfig(config, {
    ...(dependencies.hermeticGatewayOrigin
      ? { hermeticGatewayOrigin: dependencies.hermeticGatewayOrigin }
      : {}),
  });
  if (
    !dependencies.hermeticGatewayOrigin &&
    process.versions.node !== MANAGED_AGENT_CONTRACT.certificationNodeVersion
  ) {
    throw new Error(
      `Direct managed-agent probes require Node ${MANAGED_AGENT_CONTRACT.certificationNodeVersion}; current runtime is ${process.versions.node}`,
    );
  }
  if (config.scenario === "L2" && !dependencies.waitForCancellationSignal) {
    throw new Error("L2 requires an explicit cancellation signal dependency");
  }

  const createUuid = dependencies.uuid ?? randomUUID;
  const runId = createUuid();
  const executionId = createUuid();
  const evalSource = safeEvalSource(
    config.scenario,
    config.target,
    executionId,
  );
  const recorder = new ManagedAgentEventRecorder(runId, validated.model.alias);
  const mcpRuntime = createManagedAgentMcpRuntime(config.expectedMcpNonce);
  const abortController = new AbortController();
  const triggerController = new AbortController();
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const before = await captureManagedAgentWorkspaceSnapshot(
    validated.canonicalWorkspaceRoot,
  );
  const childEnvironment = buildManagedAgentChildEnvironment({
    ambient: process.env,
    configRoot: validated.canonicalConfigRoot,
    gatewayOrigin: validated.gatewayOrigin,
    gatewayCredential: config.gatewayCredential,
    modelAlias: validated.model.alias,
    evalSource,
    executionId,
  });
  const processObserver =
    dependencies.processObserver ??
    createLocalManagedAgentProcessObserver({ monotonicNow });
  let cancellationRequested = false;
  let teardownDeadline: ManagedAgentTeardownDeadline | undefined;
  const ensureTeardownDeadline = (): ManagedAgentTeardownDeadline => {
    if (!teardownDeadline) {
      const startedAtMs = monotonicNow();
      teardownDeadline = Object.freeze({
        startedAtMs,
        deadlineAtMs: startedAtMs + MANAGED_AGENT_TEARDOWN_TIMEOUT_MS,
      });
      // The observer must see the exact same deadline before the first abort,
      // SDK close, or iterator return. This also arms a previously observed
      // SDK-forwarded abort without granting it an unbounded cleanup window.
      processObserver.beginTeardown(teardownDeadline);
    }
    return teardownDeadline;
  };
  let query: ManagedAgentQuery | undefined;
  let iterator: AsyncIterator<unknown> | undefined;
  let queryFailed = false;
  let queryClosed = false;
  let cancellationTriggerFailed = false;
  let cancellationSignalReady = false;
  let queryIterationSettled = false;
  let toolProcessContainmentArmed = false;
  let policyPreflightFailed = false;
  let promptEmbedded = false;
  let eventNormalizationFailure: ManagedAgentProbeResult["terminationEvidence"]["eventNormalizationFailure"];
  let queryExecution: ManagedAgentQueryExecutionOutcome = "not_started";
  const guardRejections: ManagedAgentPreToolUseGuardRejection[] = [];

  const policyBoundary = createManagedAgentPolicyBoundary({
    canonicalWorkspaceRoot: validated.canonicalWorkspaceRoot,
    allowedBuiltinTools:
      config.scenario === "L2"
        ? MANAGED_AGENT_L2_BUILTIN_TOOLS
        : MANAGED_AGENT_BUILTIN_TOOLS,
    allowedBashCommands: config.allowedBashCommands,
    allowedMcpTools:
      config.scenario === "L1" ? mcpRuntime.qualifiedToolNames : [],
    pathRoleBindings: config.pathRoleBindings,
    requireRegisteredFilePaths: config.scenario === "L1",
    onDecision: (evidence) => {
      recorder.recordPermission(evidence);
      if (
        config.scenario === "L2" &&
        evidence.source === "pre_tool_use" &&
        evidence.toolName === "Bash" &&
        evidence.decision === "allow" &&
        evidence.reason === "exact_bash_command"
      ) {
        toolProcessContainmentArmed = true;
        processObserver.armToolProcessContainment();
      }
    },
    onGuardRejection: (diagnostic) => guardRejections.push(diagnostic),
  });

  const options: Options = {
    abortController,
    // PreToolUse is the universal boundary. canUseTool only handles an
    // unresolved SDK permission as defense in depth; the shared evaluator
    // deduplicates its evidence by tool-use ID.
    canUseTool: policyBoundary.canUseToolFallback,
    cwd: validated.canonicalWorkspaceRoot,
    disallowedTools:
      config.scenario === "L2"
        ? [...MANAGED_AGENT_L2_DISALLOWED_TOOLS]
        : [...MANAGED_AGENT_DISALLOWED_TOOLS],
    env: childEnvironment,
    includePartialMessages: false,
    hooks: {
      PreToolUse: [
        {
          hooks: [policyBoundary.preToolUseHook],
          timeout: 5,
        },
      ],
    },
    maxBudgetUsd: config.maxBudgetUsd,
    maxTurns: config.maxTurns,
    mcpServers:
      config.scenario === "L1"
        ? { [MANAGED_AGENT_MCP_SERVER_NAME]: mcpRuntime.server }
        : {},
    model: validated.model.alias,
    permissionMode: "default",
    persistSession: false,
    settingSources: [],
    skills: [],
    spawnClaudeCodeProcess: (spawnOptions) =>
      processObserver.spawn(spawnOptions),
    stderr: () => {
      // Do not retain or print SDK stderr; probe artifacts are structural only.
    },
    strictMcpConfig: true,
    systemPrompt:
      config.scenario === "L2"
        ? "You are a deterministic local cancellation probe. Use only the one exact Bash call named in the prompt."
        : "You are a deterministic local managed-agent feasibility probe. Follow the ordered instructions exactly, continue after expected permission denials and planned MCP errors, and use only the tools named in the prompt.",
    thinking: { type: "disabled" },
    tools:
      config.scenario === "L2"
        ? [...MANAGED_AGENT_L2_BUILTIN_TOOLS]
        : [...MANAGED_AGENT_BUILTIN_TOOLS],
  };

  let teardown!: ManagedAgentTeardownObservation;
  let terminal!: ManagedAgentTerminalClassification;
  let terminationEvidence!: ManagedAgentProbeResult["terminationEvidence"];
  let policyHookCoverage = false;
  try {
    recorder.recordLifecycle("starting");
    try {
      await (
        dependencies.policySettingsGuard ?? assertManagedAgentHooksEnabled
      )({
        cwd: validated.canonicalWorkspaceRoot,
        environment:
          buildManagedAgentSettingsGuardEnvironment(childEnvironment),
      });
    } catch {
      policyPreflightFailed = true;
      recorder.recordLifecycle("policy_preflight_failed");
      triggerController.abort();
      ensureTeardownDeadline();
      abortController.abort();
    }
    const cancellationTask =
      !policyPreflightFailed && dependencies.waitForCancellationSignal
        ? dependencies
            .waitForCancellationSignal(triggerController.signal)
            .then(() => {
              if (triggerController.signal.aborted) return;
              cancellationSignalReady = true;
              if (queryIterationSettled) return;
              cancellationRequested = true;
              recorder.recordLifecycle("cancellation_requested");
              ensureTeardownDeadline();
              abortController.abort();
            })
            .catch(() => {
              if (!triggerController.signal.aborted) {
                cancellationTriggerFailed = true;
                if (!queryIterationSettled) {
                  ensureTeardownDeadline();
                  abortController.abort();
                }
              }
            })
        : undefined;

    if (!policyPreflightFailed) {
      try {
        const prompt = buildManagedAgentCorrelationPrompt({
          prompt: config.prompt,
          evalSource,
          executionId,
        });
        promptEmbedded = true;
        try {
          query = (dependencies.queryFactory ?? defaultQueryFactory)({
            prompt,
            options,
          });
        } catch (error) {
          queryExecution = "construction_failed";
          throw error;
        }
        iterator = query[Symbol.asyncIterator]();
        for (;;) {
          const step = await nextManagedAgentEvent(
            iterator,
            abortController.signal,
          );
          if (step.kind === "aborted") {
            queryExecution = "iteration_aborted";
            break;
          }
          if (step.value.done) {
            queryExecution = "iteration_completed";
            break;
          }
          try {
            recorder.observeSdkEvent(step.value.value);
          } catch (error) {
            if (error instanceof ManagedAgentEventError) {
              eventNormalizationFailure = error.reason;
              queryExecution = "event_normalization_failed";
            }
            throw error;
          }
        }
      } catch {
        if (eventNormalizationFailure) {
          queryExecution = "event_normalization_failed";
        } else if (!query) {
          queryExecution = "construction_failed";
        } else {
          queryExecution = abortController.signal.aborted
            ? "iteration_aborted"
            : "iteration_failed";
        }
        if (!abortController.signal.aborted) queryFailed = true;
      } finally {
        queryIterationSettled = true;
        const armedEarlyQuerySettlement =
          toolProcessContainmentArmed &&
          Boolean(cancellationTask) &&
          !abortController.signal.aborted &&
          !cancellationSignalReady;
        if (armedEarlyQuerySettlement) {
          const deadline = ensureTeardownDeadline();
          const taskSettled = await waitForTaskBounded(
            cancellationTask!,
            deadline,
            monotonicNow,
          );
          if (!taskSettled || !cancellationSignalReady) {
            cancellationTriggerFailed = true;
          }
        }
        triggerController.abort();
        if (cancellationTask && !armedEarlyQuerySettlement) {
          await cancellationTask;
        }
        queryFailed ||= cancellationTriggerFailed;
        // Give the SDK its documented graceful-shutdown path before host
        // fallback containment. The observer binds only SpawnOptions.signal,
        // which the SDK forwards after stdin EOF and its bounded grace period.
        if (
          (queryFailed || armedEarlyQuerySettlement) &&
          !abortController.signal.aborted
        ) {
          ensureTeardownDeadline();
          abortController.abort();
        }
        if (query) {
          // Establish the one deadline before close() or iterator.return() can
          // begin. Natural completion is teardown-relevant too.
          const deadline = ensureTeardownDeadline();
          queryClosed = await closeQueryBounded(
            query,
            iterator,
            deadline,
            monotonicNow,
          );
        }
        if ((query && !queryClosed) || queryFailed) {
          ensureTeardownDeadline();
          abortController.abort();
        }
      }
    }

    const deadline = ensureTeardownDeadline();
    if (abortController.signal.aborted) {
      teardown = await processObserver.emergencyCleanup(deadline);
    } else {
      teardown = await processObserver.waitForQuiescence(deadline);
      if (!teardown.quiescent) {
        teardown = await processObserver.emergencyCleanup(deadline);
      }
    }
    const totalElapsedMs = Math.max(0, monotonicNow() - deadline.startedAtMs);
    teardown = {
      ...teardown,
      elapsedMs: totalElapsedMs,
      deadlineMet:
        teardown.quiescent &&
        teardown.processTableAvailable &&
        teardown.containmentSupported &&
        monotonicNow() <= deadline.deadlineAtMs,
    };
    const beforePolicyOverride = classifyTerminal({
      teardown,
      queryCreated: query !== undefined,
      queryClosed,
      cancellationRequested,
      queryFailed,
      sdkResult: recorder.result,
    });
    terminal = beforePolicyOverride;
    if (
      policyPreflightFailed &&
      terminal !== "teardown_timeout" &&
      terminal !== "close_timeout"
    ) {
      terminal = "policy_violation";
    }
    policyHookCoverage =
      !policyPreflightFailed &&
      !eventNormalizationFailure &&
      hasUniversalPolicyHookCoverage(
        recorder.toolEvidence,
        recorder.permissionEvidence,
      );
    if (
      !policyHookCoverage &&
      terminal !== "teardown_timeout" &&
      terminal !== "close_timeout"
    ) {
      terminal = "policy_violation";
    }
    recorder.recordTerminal(terminal);

    const sdkResult = recorder.result
      ? recorder.result.isError
        ? "error"
        : "success"
      : "not_observed";
    terminationEvidence = {
      beforePolicyOverride,
      queryExecution,
      sdkResult,
      ...(eventNormalizationFailure ? { eventNormalizationFailure } : {}),
    };
  } finally {
    await processObserver.dispose();
  }

  const after = await captureManagedAgentWorkspaceSnapshot(
    validated.canonicalWorkspaceRoot,
  );
  const policyDiagnostics = buildManagedAgentPolicyDiagnostics(
    recorder.toolEvidence,
    recorder.permissionEvidence,
    guardRejections,
  );
  return deepFreezeEvidence({
    contractVersion: 1,
    runId,
    scenario: config.scenario,
    target: config.target,
    modelAlias: validated.model.alias,
    sdkModelEvidence: recorder.modelEvidence,
    ...(recorder.sessionId ? { sdkSessionId: recorder.sessionId } : {}),
    inferenceTurns: recorder.inferenceTurns,
    ...(recorder.sdkNumTurns === undefined
      ? {}
      : { sdkNumTurns: recorder.sdkNumTurns }),
    policyHookCoverage,
    terminal,
    terminationEvidence,
    events: [...recorder.events],
    toolEvidence: [...recorder.toolEvidence],
    permissionEvidence: [...recorder.permissionEvidence],
    policyDiagnostics,
    workspaceChanges: diffManagedAgentWorkspaceSnapshots(before, after),
    preservation: observeManagedAgentPreservation(
      before,
      after,
      config.preservePaths ?? [],
    ),
    cancellationRequested,
    queryClosed,
    teardown,
    correlation: { executionId, evalSource, promptEmbedded },
    ...(config.scenario === "L1"
      ? {
          l1Certification: {
            contractVersion:
              MANAGED_AGENT_L1_CERTIFICATION_CONTRACT.contractVersion,
            promptVersion:
              MANAGED_AGENT_L1_CERTIFICATION_CONTRACT.promptVersion,
          },
          l1FinalBytes: observeManagedAgentL1FinalBytes(
            after,
            config.expectedL1FinalBytes,
          ),
          nonceVerified: mcpRuntime.invocations.some(
            ({ toolName, status }) =>
              toolName === qualifiedManagedAgentMcpToolName("echo_nonce") &&
              status === "success",
          ),
        }
      : {}),
    ...(recorder.usage ? { sdkUsage: recorder.usage } : {}),
  });
}
