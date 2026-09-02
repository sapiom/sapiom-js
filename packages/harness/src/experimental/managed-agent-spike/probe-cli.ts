#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  verifyManagedAgentFixtureBytes,
  waitForManagedAgentFixturePids,
} from "./fixture.js";
import {
  MANAGED_AGENT_CONTRACT,
  MANAGED_AGENT_L1_CERTIFICATION_CONTRACT,
  assertManagedAgentDirectGatewayOrigin,
  resolveManagedAgentModelTarget,
} from "./contract.js";
import { createLocalManagedAgentProcessObserver } from "./process-observer.js";
import {
  qualifiedManagedAgentMcpToolName,
  runManagedAgentProbe,
} from "./runtime.js";
import type {
  ManagedAgentModelTargetId,
  ManagedAgentOperationId,
  ManagedAgentPathRole,
  ManagedAgentPermissionReason,
  ManagedAgentProbeResult,
  ManagedAgentProbeScenario,
} from "./types.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ManagedAgentProbeCliArgs {
  readonly help: boolean;
  readonly live: boolean;
  readonly target?: ManagedAgentModelTargetId;
  readonly scenario?: ManagedAgentProbeScenario;
}

export interface ManagedAgentProbeCheck {
  readonly id: string;
  readonly passed: boolean;
}

export interface ManagedAgentProbeReport {
  /** Local protocol/host result; never authoritative deployment certification. */
  readonly outcome: "local_pass" | "fail";
  readonly deploymentProvenance: "requires_gateway_reconciliation";
  readonly checks: readonly ManagedAgentProbeCheck[];
  readonly result: ManagedAgentProbeResult;
  readonly l1Certification?: {
    readonly contractVersion: number;
    readonly promptVersion: string;
    readonly evaluatorVersion: string;
    readonly optionalReadCount: number;
    readonly optionalReadRole?: ManagedAgentPathRole;
  };
}

export class ManagedAgentProbeCliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ManagedAgentProbeCliError";
  }
}

interface ManagedAgentExpectedL1ToolStep {
  readonly toolName: string;
  readonly completion: "success" | "error";
  readonly decision: "allow" | "deny";
  readonly reason: ManagedAgentPermissionReason;
  readonly operationId: ManagedAgentOperationId;
}

const MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE = Object.freeze([
  {
    toolName: "Read",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
    operationId: "read:clean_target",
  },
  {
    toolName: "Read",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
    operationId: "read:dirty_sentinel",
  },
  {
    toolName: "Read",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
    operationId: "read:untracked_sentinel",
  },
  {
    toolName: "Read",
    completion: "error",
    decision: "deny",
    reason: "path_outside_workspace",
    operationId: "read:outside_sentinel",
  },
  {
    toolName: "Read",
    completion: "error",
    decision: "deny",
    reason: "path_symlink_escape",
    operationId: "read:escape_link",
  },
  {
    toolName: "Edit",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
    operationId: "edit:clean_target",
  },
  {
    toolName: "Write",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
    operationId: "write:managed_output",
  },
  {
    toolName: qualifiedManagedAgentMcpToolName("echo_nonce"),
    completion: "success",
    decision: "allow",
    reason: "managed_mcp_tool",
    operationId: "mcp:echo_nonce",
  },
  {
    toolName: qualifiedManagedAgentMcpToolName("fail_once"),
    completion: "error",
    decision: "allow",
    reason: "managed_mcp_tool",
    operationId: "mcp:fail_once",
  },
  {
    toolName: qualifiedManagedAgentMcpToolName("fail_once"),
    completion: "success",
    decision: "allow",
    reason: "managed_mcp_tool",
    operationId: "mcp:fail_once",
  },
  {
    toolName: "Bash",
    completion: "success",
    decision: "allow",
    reason: "exact_bash_command",
    operationId: "bash:exact_command",
  },
] as const satisfies readonly ManagedAgentExpectedL1ToolStep[]);

const MANAGED_AGENT_L1_OPTIONAL_READ_OPERATIONS =
  new Set<ManagedAgentOperationId>([
    "read:clean_target",
    "read:dirty_sentinel",
    "read:untracked_sentinel",
  ]);

interface ManagedAgentL1TraceAnalysis {
  readonly passed: boolean;
  readonly optionalReadCount: number;
  readonly optionalReadRole?: ManagedAgentPathRole;
}

function hasExactManagedAgentL1WorkspaceDelta(
  result: ManagedAgentProbeResult,
): boolean {
  const expected = [
    { path: FIXTURE_PATHS.cleanTarget, change: "modified" },
    { path: FIXTURE_PATHS.createdTarget, change: "created" },
  ] as const;
  return (
    result.workspaceChanges.length === expected.length &&
    expected.every(
      (expectedChange) =>
        result.workspaceChanges.filter(
          ({ path, change }) =>
            path === expectedChange.path && change === expectedChange.change,
        ).length === 1,
    )
  );
}

function hasExactManagedAgentL1FinalBytes(
  result: ManagedAgentProbeResult,
): boolean {
  const roles = ["clean_target", "managed_output"] as const;
  return Boolean(
    result.l1FinalBytes?.length === roles.length &&
    roles.every(
      (role) =>
        result.l1FinalBytes?.filter(
          (observation) => observation.role === role && observation.matched,
        ).length === 1,
    ),
  );
}

function hasConsistentManagedAgentL1EventProjection(
  result: ManagedAgentProbeResult,
): boolean {
  if (
    result.events.some(
      (event, index) =>
        event.sequence !== index + 1 || event.runId !== result.runId,
    )
  ) {
    return false;
  }
  const toolEvents = result.events.filter(
    ({ type }) => type === "tool_requested" || type === "tool_completed",
  );
  if (toolEvents.length !== result.toolEvidence.length) return false;
  for (const [index, evidence] of result.toolEvidence.entries()) {
    const event = toolEvents[index];
    if (
      !event ||
      event.toolUseId !== evidence.toolUseId ||
      event.toolName !== evidence.toolName
    ) {
      return false;
    }
    if (evidence.status === "requested") {
      if (event.type !== "tool_requested" || event.isError !== undefined) {
        return false;
      }
    } else if (
      event.type !== "tool_completed" ||
      event.isError !== (evidence.status === "error")
    ) {
      return false;
    }
  }

  const permissionEvents = result.events.flatMap((event, index) =>
    event.type === "permission" ? [{ event, index }] : [],
  );
  if (permissionEvents.length !== result.permissionEvidence.length) {
    return false;
  }
  const completionIndexByToolUseId = new Map<string, number>();
  for (const [index, event] of result.events.entries()) {
    if (event.type === "tool_completed" && event.toolUseId) {
      completionIndexByToolUseId.set(event.toolUseId, index);
    }
  }
  return result.permissionEvidence.every((evidence, index) => {
    const permission = permissionEvents[index];
    const event = permission?.event;
    const completionIndex = completionIndexByToolUseId.get(evidence.toolUseId);
    return Boolean(
      event &&
      event.toolUseId === evidence.toolUseId &&
      event.toolName === evidence.toolName &&
      event.permissionDecision === evidence.decision &&
      event.permissionReason === evidence.reason &&
      event.permissionSource === evidence.source &&
      event.operationId === evidence.operationId &&
      completionIndex !== undefined &&
      permission.index < completionIndex,
    );
  });
}

function hasManagedAgentL1BashSdkTerminalOrder(
  result: ManagedAgentProbeResult,
): boolean {
  const bashRequest = result.toolEvidence.find(
    ({ toolName, status }) => toolName === "Bash" && status === "requested",
  );
  if (!bashRequest?.toolUseId) return false;
  const bashCompletionIndexes = result.events.flatMap((event, index) =>
    event.type === "tool_completed" &&
    event.toolUseId === bashRequest.toolUseId &&
    event.toolName === "Bash" &&
    event.isError === false
      ? [index]
      : [],
  );
  const sdkResultIndexes = result.events.flatMap((event, index) =>
    event.type === "sdk_result" &&
    event.subtype === "success" &&
    event.isError === false
      ? [index]
      : [],
  );
  const terminalIndexes = result.events.flatMap((event, index) =>
    event.type === "terminal" && event.terminal === "success" ? [index] : [],
  );
  const bashCompletionIndex = bashCompletionIndexes[0];
  const sdkResultIndex = sdkResultIndexes[0];
  const terminalIndex = terminalIndexes[0];
  return Boolean(
    bashCompletionIndexes.length === 1 &&
    result.events.filter(({ type }) => type === "sdk_result").length === 1 &&
    sdkResultIndexes.length === 1 &&
    result.events.filter(({ type }) => type === "terminal").length === 1 &&
    terminalIndexes.length === 1 &&
    result.terminationEvidence.sdkResult === "success" &&
    bashCompletionIndex !== undefined &&
    sdkResultIndex !== undefined &&
    terminalIndex !== undefined &&
    bashCompletionIndex < sdkResultIndex &&
    sdkResultIndex < terminalIndex &&
    terminalIndex === result.events.length - 1,
  );
}

function analyzeManagedAgentL1ToolTrace(
  result: ManagedAgentProbeResult,
): ManagedAgentL1TraceAnalysis {
  const requested = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  );
  const completed = result.toolEvidence.filter(
    ({ status }) => status !== "requested",
  );
  const primaryDecisions = result.permissionEvidence.filter(
    ({ source }) => source === "pre_tool_use",
  );
  const requestedIds = requested.flatMap(({ toolUseId }) =>
    toolUseId?.trim() ? [toolUseId] : [],
  );
  const requestedById = new Map(
    requestedIds.map((toolUseId, index) => [toolUseId, requested[index]!]),
  );
  const completionById = new Map(
    completed.flatMap((evidence) =>
      evidence.toolUseId ? [[evidence.toolUseId, evidence] as const] : [],
    ),
  );
  const decisionById = new Map(
    primaryDecisions.map((evidence) => [evidence.toolUseId, evidence]),
  );
  const requestPositionById = new Map<string, number>();
  const completionPositionById = new Map<string, number>();
  for (const [position, evidence] of result.toolEvidence.entries()) {
    if (!evidence.toolUseId) continue;
    if (evidence.status === "requested") {
      if (!requestPositionById.has(evidence.toolUseId)) {
        requestPositionById.set(evidence.toolUseId, position);
      }
    } else if (!completionPositionById.has(evidence.toolUseId)) {
      completionPositionById.set(evidence.toolUseId, position);
    }
  }
  let invalid =
    requestedIds.length !== requested.length ||
    new Set(requestedIds).size !== requestedIds.length ||
    completed.length !== requested.length ||
    completionById.size !== completed.length ||
    primaryDecisions.length !== requested.length ||
    decisionById.size !== primaryDecisions.length ||
    result.permissionEvidence.length !== primaryDecisions.length ||
    result.permissionEvidence.some(({ source }) => source !== "pre_tool_use") ||
    completed.some(
      ({ toolUseId, toolName }) =>
        !toolUseId || requestedById.get(toolUseId)?.toolName !== toolName,
    ) ||
    primaryDecisions.some(
      ({ toolUseId, toolName }) =>
        requestedById.get(toolUseId)?.toolName !== toolName,
    );

  const matches = (
    requestIndex: number,
    expected: ManagedAgentExpectedL1ToolStep,
  ): boolean => {
    const request = requested[requestIndex];
    if (!request?.toolUseId || request.toolName !== expected.toolName) {
      return false;
    }
    const completion = completionById.get(request.toolUseId);
    const decision = decisionById.get(request.toolUseId);
    return Boolean(
      completion?.toolName === expected.toolName &&
      completion.status === expected.completion &&
      decision?.toolName === expected.toolName &&
      decision.decision === expected.decision &&
      decision.reason === expected.reason &&
      decision.operationId === expected.operationId,
    );
  };

  let cursor = 0;
  for (const expected of MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE.slice(0, 5)) {
    invalid ||= !matches(cursor, expected);
    cursor += 1;
  }

  const firstCanonicalReadByOperation = new Set<ManagedAgentOperationId>();
  const optionalVerificationReads = requested.filter((request) => {
    if (!request.toolUseId || request.toolName !== "Read") return false;
    const decision = decisionById.get(request.toolUseId);
    if (
      !decision ||
      !MANAGED_AGENT_L1_OPTIONAL_READ_OPERATIONS.has(decision.operationId)
    ) {
      return false;
    }
    if (!firstCanonicalReadByOperation.has(decision.operationId)) {
      firstCanonicalReadByOperation.add(decision.operationId);
      return false;
    }
    return true;
  });
  const optionalReadCount = optionalVerificationReads.length;
  const optionalOperation =
    optionalReadCount === 1 && optionalVerificationReads[0]?.toolUseId
      ? decisionById.get(optionalVerificationReads[0].toolUseId)?.operationId
      : undefined;
  const optionalReadRole = optionalOperation?.startsWith("read:")
    ? (optionalOperation.slice("read:".length) as ManagedAgentPathRole)
    : undefined;

  const candidate = requested[cursor];
  const candidateDecision = candidate?.toolUseId
    ? decisionById.get(candidate.toolUseId)
    : undefined;
  let optionalRequestIndex: number | undefined;
  if (
    candidate?.toolName === "Read" &&
    candidateDecision &&
    MANAGED_AGENT_L1_OPTIONAL_READ_OPERATIONS.has(candidateDecision.operationId)
  ) {
    optionalRequestIndex = cursor;
    const completion = candidate.toolUseId
      ? completionById.get(candidate.toolUseId)
      : undefined;
    invalid ||=
      completion?.toolName !== "Read" ||
      completion.status !== "success" ||
      candidateDecision.toolName !== "Read" ||
      candidateDecision.decision !== "allow" ||
      candidateDecision.reason !== "fixture_path";
    cursor += 1;
  }

  for (const expected of MANAGED_AGENT_EXPECTED_L1_TOOL_TRACE.slice(5)) {
    invalid ||= !matches(cursor, expected);
    cursor += 1;
  }
  invalid ||= cursor !== requested.length;

  const requestPosition = (requestIndex: number): number | undefined => {
    const toolUseId = requested[requestIndex]?.toolUseId;
    return toolUseId ? requestPositionById.get(toolUseId) : undefined;
  };
  const completionPosition = (requestIndex: number): number | undefined => {
    const toolUseId = requested[requestIndex]?.toolUseId;
    return toolUseId ? completionPositionById.get(toolUseId) : undefined;
  };
  const allRequestsPrecedeOwnCompletion = requested.every((_, index) => {
    const request = requestPosition(index);
    const completion = completionPosition(index);
    return (
      request !== undefined && completion !== undefined && request < completion
    );
  });
  const completionsBeforeRequest = (
    completedRequestIndexes: readonly number[],
    boundaryRequestIndex: number,
  ): boolean => {
    const boundary = requestPosition(boundaryRequestIndex);
    const completions = completedRequestIndexes.map(completionPosition);
    return Boolean(
      boundary !== undefined &&
      completions.every(
        (completion) => completion !== undefined && completion < boundary,
      ),
    );
  };
  const optionalOffset = optionalRequestIndex === undefined ? 0 : 1;
  const call6RequestIndex = 5 + optionalOffset;
  const call10RequestIndex = 9 + optionalOffset;
  const call11RequestIndex = 10 + optionalOffset;
  const phaseABoundaryRequestIndex = optionalRequestIndex ?? call6RequestIndex;
  invalid ||=
    !allRequestsPrecedeOwnCompletion ||
    !completionsBeforeRequest([0, 1, 2, 3, 4], phaseABoundaryRequestIndex) ||
    !completionsBeforeRequest(
      [
        call6RequestIndex,
        call6RequestIndex + 1,
        call6RequestIndex + 2,
        call6RequestIndex + 3,
      ],
      call10RequestIndex,
    );
  if (optionalRequestIndex !== undefined) {
    const optionalRequest = requestPosition(optionalRequestIndex);
    const optionalCompletion = completionPosition(optionalRequestIndex);
    const call6Request = requestPosition(call6RequestIndex);
    invalid ||=
      optionalRequest === undefined ||
      optionalCompletion === undefined ||
      call6Request === undefined ||
      optionalRequest >= optionalCompletion ||
      optionalCompletion >= call6Request;
  }
  const call10Completion = completionPosition(call10RequestIndex);
  const call11Request = requestPosition(call11RequestIndex);
  invalid ||=
    call10Completion === undefined ||
    call11Request === undefined ||
    call10Completion >= call11Request;

  return {
    passed: !invalid,
    optionalReadCount,
    ...(optionalReadRole ? { optionalReadRole } : {}),
  };
}

function hasExactManagedAgentL2BashTrace(
  result: ManagedAgentProbeResult,
): boolean {
  const requested = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  );
  const completed = result.toolEvidence.filter(
    ({ status }) => status !== "requested",
  );
  const primaryDecisions = result.permissionEvidence.filter(
    ({ source }) => source === "pre_tool_use",
  );
  const request = requested[0];
  return Boolean(
    requested.length === 1 &&
    request?.toolUseId &&
    request.toolName === "Bash" &&
    completed.length <= 1 &&
    completed.every(
      (evidence) =>
        evidence.toolUseId === request.toolUseId &&
        evidence.toolName === "Bash" &&
        evidence.status === "error",
    ) &&
    primaryDecisions.length === 1 &&
    result.permissionEvidence.length === 1 &&
    primaryDecisions[0]?.toolUseId === request.toolUseId &&
    primaryDecisions[0]?.toolName === "Bash" &&
    primaryDecisions[0]?.decision === "allow" &&
    primaryDecisions[0]?.reason === "exact_bash_command" &&
    primaryDecisions[0]?.operationId === "bash:exact_command",
  );
}

export function managedAgentProbeUsage(): string {
  return [
    "Usage:",
    "  pnpm --filter @sapiom/harness probe:managed-agent -- --live --scenario <L1|L2> --target <sonnet-5|minimax-m3>",
    "",
    "Required environment (dedicated eval access only):",
    "  LLM_GATEWAY_BASE_URL",
    "  LLM_GATEWAY_EVAL_API_KEY",
    "",
    "Credentials are intentionally not accepted as command-line arguments.",
  ].join("\n");
}

export function parseManagedAgentProbeCliArgs(
  argv: readonly string[],
): ManagedAgentProbeCliArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, live: false };
  }
  let live = false;
  let target: ManagedAgentModelTargetId | undefined;
  let scenario: ManagedAgentProbeScenario | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live") {
      live = true;
      continue;
    }
    if (argument === "--target") {
      const value = argv[++index];
      if (value !== "sonnet-5" && value !== "minimax-m3") {
        throw new ManagedAgentProbeCliError(
          "--target must be sonnet-5 or minimax-m3",
        );
      }
      target = value;
      continue;
    }
    if (argument === "--scenario") {
      const value = argv[++index];
      if (value !== "L1" && value !== "L2") {
        throw new ManagedAgentProbeCliError("--scenario must be L1 or L2");
      }
      scenario = value;
      continue;
    }
    throw new ManagedAgentProbeCliError(
      `Unknown argument: ${String(argument)}`,
    );
  }
  if (!live) {
    throw new ManagedAgentProbeCliError(
      "Refusing to run without --live; hermetic tests never contact the gateway",
    );
  }
  if (!target || !scenario) {
    throw new ManagedAgentProbeCliError("--target and --scenario are required");
  }
  return { help: false, live, target, scenario };
}

function requiredEnvironmentValue(
  environment: Environment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new ManagedAgentProbeCliError(`${name} is required`);
  return value;
}

export function assertManagedAgentCertificationNodeVersion(
  runtimeVersion: string,
): void {
  if (runtimeVersion !== MANAGED_AGENT_CONTRACT.certificationNodeVersion) {
    throw new ManagedAgentProbeCliError(
      `Live probes require Node ${MANAGED_AGENT_CONTRACT.certificationNodeVersion}; current runtime is ${runtimeVersion}`,
    );
  }
}

export function assertManagedAgentCancellationHostPlatform(
  platform: NodeJS.Platform,
): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new ManagedAgentProbeCliError(
      "L2 certification supports only the reviewed detached POSIX fixture containment model",
    );
  }
}

export function evaluateManagedAgentProbe(
  result: ManagedAgentProbeResult,
  fixturePids: readonly number[] = [],
): ManagedAgentProbeReport {
  const l1Trace =
    result.scenario === "L1"
      ? analyzeManagedAgentL1ToolTrace(result)
      : undefined;
  const requestedTools = new Set(
    result.toolEvidence
      .filter(({ status }) => status === "requested")
      .map(({ toolName }) => toolName),
  );
  const invocation = (toolName: string, status: "success" | "error"): boolean =>
    result.toolEvidence.some(
      (evidence) =>
        evidence.toolName === toolName && evidence.status === status,
    );
  const permission = (
    toolName: string,
    decision: "allow" | "deny",
    reason: ManagedAgentPermissionReason,
  ): boolean =>
    result.permissionEvidence.some(
      (evidence) =>
        evidence.toolName === toolName &&
        evidence.decision === decision &&
        evidence.reason === reason &&
        evidence.source === "pre_tool_use",
    );
  const requestedToolIds = result.toolEvidence.flatMap((evidence) =>
    evidence.status === "requested" && evidence.toolUseId
      ? [evidence.toolUseId]
      : [],
  );
  const universalHookCoverage =
    requestedToolIds.length > 0 &&
    new Set(requestedToolIds).size === requestedToolIds.length &&
    requestedToolIds.every(
      (toolUseId) =>
        result.permissionEvidence.filter(
          (evidence) =>
            evidence.toolUseId === toolUseId &&
            evidence.source === "pre_tool_use",
        ).length === 1,
    );
  const checks: ManagedAgentProbeCheck[] = [
    {
      id: "sdk_model_alias_observed",
      passed:
        result.modelAlias ===
          resolveManagedAgentModelTarget(result.target).alias &&
        result.sdkModelEvidence.initModelObserved &&
        result.sdkModelEvidence.initModelMatchesExpectedAlias &&
        (result.sdkModelEvidence.resultModelUsageObserved
          ? result.sdkModelEvidence.resultModelUsageMatchesExpectedAlias &&
            result.sdkModelEvidence.resultModelCount === 1
          : result.scenario === "L2" && result.terminal === "cancelled"),
    },
    { id: "sdk_session_observed", passed: Boolean(result.sdkSessionId) },
    { id: "query_closed", passed: result.queryClosed },
    { id: "process_tree_quiescent", passed: result.teardown.quiescent },
    {
      id: "universal_policy_hook_coverage",
      passed: result.policyHookCoverage && universalHookCoverage,
    },
    {
      id: "bounded_inference_turn_evidence",
      passed:
        Number.isInteger(result.inferenceTurns) &&
        result.inferenceTurns > 0 &&
        result.inferenceTurns <= MANAGED_AGENT_CONTRACT.maxTurns &&
        (result.sdkNumTurns === undefined ||
          (Number.isInteger(result.sdkNumTurns) &&
            result.sdkNumTurns >= 0 &&
            result.sdkNumTurns <= MANAGED_AGENT_CONTRACT.maxTurns)),
    },
    {
      id: "dirty_and_untracked_preserved",
      passed:
        result.preservation.length === 2 &&
        [FIXTURE_PATHS.dirtySentinel, FIXTURE_PATHS.untrackedSentinel].every(
          (path) =>
            result.preservation.filter(
              (observation) =>
                observation.path === path && observation.preserved,
            ).length === 1,
        ),
    },
  ];

  if (result.scenario === "L1") {
    checks.push(
      { id: "terminal_success", passed: result.terminal === "success" },
      {
        id: "l1_contract_v2",
        passed:
          result.correlation.promptEmbedded &&
          result.l1Certification?.contractVersion ===
            MANAGED_AGENT_L1_CERTIFICATION_CONTRACT.contractVersion &&
          result.l1Certification.promptVersion ===
            MANAGED_AGENT_L1_CERTIFICATION_CONTRACT.promptVersion,
      },
      {
        id: "exact_l1_tool_trace",
        passed: l1Trace?.passed === true,
      },
      {
        id: "minimum_l1_inference_turns",
        passed:
          Number.isInteger(result.inferenceTurns) &&
          result.inferenceTurns >= 4 + (l1Trace?.optionalReadCount ?? 0),
      },
      {
        id: "normalized_event_projection",
        passed: hasConsistentManagedAgentL1EventProjection(result),
      },
      {
        id: "bash_sdk_terminal_order",
        passed: hasManagedAgentL1BashSdkTerminalOrder(result),
      },
      {
        id: "exact_workspace_delta",
        passed: hasExactManagedAgentL1WorkspaceDelta(result),
      },
      {
        id: "expected_final_bytes",
        passed: hasExactManagedAgentL1FinalBytes(result),
      },
      { id: "nonce_verified", passed: result.nonceVerified === true },
      {
        id: "builtin_tools_succeeded",
        passed: ["Read", "Edit", "Write", "Bash"].every(
          (name) => requestedTools.has(name) && invocation(name, "success"),
        ),
      },
      {
        id: "mcp_echo_succeeded",
        passed: invocation(
          qualifiedManagedAgentMcpToolName("echo_nonce"),
          "success",
        ),
      },
      {
        id: "mcp_failure_recovered",
        passed:
          invocation(qualifiedManagedAgentMcpToolName("fail_once"), "error") &&
          invocation(qualifiedManagedAgentMcpToolName("fail_once"), "success"),
      },
      {
        id: "expected_permissions_allowed",
        passed:
          ["Read", "Edit", "Write"].every((toolName) =>
            permission(toolName, "allow", "fixture_path"),
          ) &&
          permission("Bash", "allow", "exact_bash_command") &&
          permission(
            qualifiedManagedAgentMcpToolName("echo_nonce"),
            "allow",
            "managed_mcp_tool",
          ) &&
          permission(
            qualifiedManagedAgentMcpToolName("fail_once"),
            "allow",
            "managed_mcp_tool",
          ),
      },
      {
        id: "outside_and_symlink_denied",
        passed:
          permission("Read", "deny", "path_outside_workspace") &&
          permission("Read", "deny", "path_symlink_escape"),
      },
    );
  } else {
    checks.push(
      { id: "terminal_cancelled", passed: result.terminal === "cancelled" },
      {
        id: "exact_l2_bash_only_trace",
        passed: hasExactManagedAgentL2BashTrace(result),
      },
      { id: "cancellation_requested", passed: result.cancellationRequested },
      {
        id: "teardown_within_five_seconds",
        passed: result.teardown.quiescent && result.teardown.deadlineMet,
      },
      {
        id: "l2_containment_prepared",
        passed:
          result.teardown.processTableAvailable &&
          result.teardown.containmentSupported &&
          result.teardown.ownershipProven &&
          result.teardown.toolProcessObservationComplete,
      },
      {
        id: "sdk_closed_tool_lifetime_channels",
        passed: result.teardown.toolProcessChannelsClosed,
      },
      {
        id: "fixture_processes_observed",
        passed:
          fixturePids.length === 2 &&
          fixturePids.every((pid) =>
            result.teardown.observedPids.includes(pid),
          ),
      },
      {
        id: "no_fixture_process_alive",
        passed:
          fixturePids.length === 2 &&
          fixturePids.every(
            (pid) => !result.teardown.alivePidsAtDeadline.includes(pid),
          ),
      },
    );
  }

  const report: ManagedAgentProbeReport = {
    outcome: checks.every(({ passed }) => passed) ? "local_pass" : "fail",
    deploymentProvenance: "requires_gateway_reconciliation",
    checks,
    result,
  };
  if (result.scenario !== "L1") return report;
  return {
    ...report,
    l1Certification: {
      contractVersion: result.l1Certification?.contractVersion ?? 0,
      promptVersion: result.l1Certification?.promptVersion ?? "unobserved",
      evaluatorVersion:
        MANAGED_AGENT_L1_CERTIFICATION_CONTRACT.evaluatorVersion,
      optionalReadCount: l1Trace?.optionalReadCount ?? 0,
      ...(l1Trace?.optionalReadRole
        ? { optionalReadRole: l1Trace.optionalReadRole }
        : {}),
    },
  };
}

export async function executeManagedAgentProbeCli(
  argv: readonly string[],
  environment: Environment = process.env,
  runtimeNodeVersion = process.versions.node,
  runtimePlatform: NodeJS.Platform = process.platform,
): Promise<
  ManagedAgentProbeReport | { readonly help: true; readonly usage: string }
> {
  const args = parseManagedAgentProbeCliArgs(argv);
  if (args.help) return { help: true, usage: managedAgentProbeUsage() };

  // Validate the immutable runtime before reading the dedicated credential.
  assertManagedAgentCertificationNodeVersion(runtimeNodeVersion);
  if (args.scenario === "L2") {
    assertManagedAgentCancellationHostPlatform(runtimePlatform);
  }
  const gatewayOrigin = assertManagedAgentDirectGatewayOrigin(
    requiredEnvironmentValue(environment, "LLM_GATEWAY_BASE_URL"),
  );
  const gatewayCredential = requiredEnvironmentValue(
    environment,
    "LLM_GATEWAY_EVAL_API_KEY",
  );
  const fixture = await createManagedAgentFixture();
  const observer = createLocalManagedAgentProcessObserver();
  let fixturePids: readonly number[] = [];
  try {
    const scenario = args.scenario!;
    const result = await runManagedAgentProbe(
      {
        scenario,
        workspaceRoot: fixture.workspaceRoot,
        configRoot: fixture.configRoot,
        target: args.target!,
        gatewayOrigin,
        gatewayCredential,
        prompt: fixture.prompt(scenario),
        maxTurns: scenario === "L1" ? 18 : 4,
        maxBudgetUsd: 0.5,
        allowedBashCommands: [
          scenario === "L1" ? fixture.l1BashCommand : fixture.l2BashCommand,
        ],
        pathRoleBindings: scenario === "L1" ? fixture.pathRoleBindings : [],
        expectedL1FinalBytes:
          scenario === "L1" ? fixture.expectedL1FinalBytes : [],
        ...(scenario === "L1" ? { expectedMcpNonce: fixture.nonce } : {}),
        preservePaths: [
          FIXTURE_PATHS.dirtySentinel,
          FIXTURE_PATHS.untrackedSentinel,
        ],
      },
      {
        processObserver: observer,
        ...(scenario === "L2"
          ? {
              waitForCancellationSignal: async (signal: AbortSignal) => {
                fixturePids = await waitForManagedAgentFixturePids(
                  fixture,
                  15_000,
                  signal,
                );
                // The model-writable PID file is evidence only. Readiness is
                // derived first from the trusted supervisor handle and bounded
                // host process table. These IDs are compared outside the
                // observer and never become signal targets.
                const readiness = await observer.prepareCancellation();
                if (!readiness.supported) {
                  throw new ManagedAgentProbeCliError(
                    `L2 containment preparation failed: ${readiness.reason}`,
                  );
                }
                if (
                  !fixturePids.every((pid) =>
                    readiness.observedPids.includes(pid),
                  )
                ) {
                  throw new ManagedAgentProbeCliError(
                    "L2 fixture PIDs were not both present in the host-observed owned process group",
                  );
                }
              },
            }
          : {}),
      },
    );
    const bytePreservation = await verifyManagedAgentFixtureBytes(fixture);
    const resultWithByteEvidence: ManagedAgentProbeResult = {
      ...result,
      preservation: bytePreservation,
    };
    return evaluateManagedAgentProbe(resultWithByteEvidence, fixturePids);
  } finally {
    await observer.dispose();
    await fixture.cleanup();
  }
}

async function main(): Promise<void> {
  try {
    const report = await executeManagedAgentProbeCli(process.argv.slice(2));
    if ("help" in report) {
      process.stdout.write(`${report.usage}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.outcome === "fail") process.exitCode = 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown probe failure";
    process.stderr.write(`managed-agent probe: ${message}\n`);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryUrl === import.meta.url) void main();
