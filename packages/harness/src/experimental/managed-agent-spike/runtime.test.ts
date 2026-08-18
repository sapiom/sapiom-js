import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import {
  MANAGED_AGENT_CONTRACT,
  MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES,
  resolveManagedAgentModelTarget,
} from "./contract.js";
import {
  FIXTURE_PATHS,
  createManagedAgentFixture,
  type ManagedAgentFixture,
} from "./fixture.js";
import {
  MANAGED_AGENT_BUILTIN_TOOLS,
  MANAGED_AGENT_DISALLOWED_TOOLS,
} from "./permissions.js";
import {
  createManagedAgentMcpRuntime,
  runManagedAgentProbe,
} from "./runtime.js";
import type {
  ManagedAgentProcessObserver,
  ManagedAgentQuery,
  ManagedAgentTeardownObservation,
} from "./types.js";

const fixtures: ManagedAgentFixture[] = [];
const SUCCESS_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CANCEL_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TIMEOUT_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CLOSE_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function quiescentTeardown(): ManagedAgentTeardownObservation {
  return {
    quiescent: true,
    deadlineMet: true,
    processTableAvailable: true,
    containmentSupported: true,
    ownershipProven: true,
    forceKillIssued: true,
    toolProcessObservationComplete: true,
    toolProcessChannelsClosed: true,
    elapsedMs: 12,
    observedPids: [],
    alivePidsAtDeadline: [],
    emergencyCleanupAttempted: false,
  };
}

function fakeObserver(
  teardown: ManagedAgentTeardownObservation = quiescentTeardown(),
): ManagedAgentProcessObserver & {
  beginTeardown: ReturnType<typeof vi.fn>;
  waitForQuiescence: ReturnType<typeof vi.fn>;
  emergencyCleanup: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    spawn: vi.fn(() => {
      throw new Error("fake query must not spawn");
    }),
    beginTeardown: vi.fn(),
    armToolProcessContainment: vi.fn(),
    prepareCancellation: vi.fn(async () => ({
      supported: true,
      reason: "ready" as const,
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: true,
      observedPids: [],
    })),
    observeProcessTree: vi.fn(async () => true),
    waitForQuiescence: vi.fn(async () => teardown),
    emergencyCleanup: vi.fn(async () => ({
      ...teardown,
      emergencyCleanupAttempted: true,
    })),
    dispose: vi.fn(),
  };
}

function queryFromEvents(
  events: readonly unknown[],
  close = vi.fn(),
): ManagedAgentQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    close,
  };
}

async function invokePreToolUse(
  options: Options,
  input: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolUseId: string;
    readonly callbackToolUseId?: string;
  },
  signal = new AbortController().signal,
): Promise<void> {
  const matcher = options.hooks?.PreToolUse?.[0];
  const hook = matcher?.hooks[0];
  if (!hook)
    throw new Error("PreToolUse hook missing from managed-agent probe");
  await hook(
    {
      hook_event_name: "PreToolUse",
      session_id: SUCCESS_SESSION_ID,
      transcript_path: "not-persisted",
      cwd: String(options.cwd),
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_use_id: input.toolUseId,
    },
    input.callbackToolUseId ?? input.toolUseId,
    { signal },
  );
}

async function probeConfig(scenario: "L1" | "L2" = "L1") {
  const fixture = await createManagedAgentFixture(() => "runtime-test-secret");
  fixtures.push(fixture);
  return {
    fixture,
    config: {
      scenario,
      workspaceRoot: fixture.workspaceRoot,
      configRoot: fixture.configRoot,
      target: "sonnet-5" as const,
      gatewayOrigin: "https://gateway.example.test",
      gatewayCredential: "dedicated-eval-secret",
      prompt: fixture.prompt(scenario),
      maxTurns: 10,
      maxBudgetUsd: 0.25,
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
  };
}

describe("runManagedAgentProbe", () => {
  it("provides deterministic MCP success and fail-once recovery", async () => {
    const runtime = createManagedAgentMcpRuntime("nonce-1");
    await expect(
      runtime.handlers.echoNonce({ nonce: "nonce-1" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "nonce-1" }],
    });
    await expect(runtime.handlers.failOnce()).resolves.toMatchObject({
      isError: true,
    });
    await expect(runtime.handlers.failOnce()).resolves.not.toHaveProperty(
      "isError",
    );
    expect(
      runtime.invocations.map(({ toolName, status }) => [toolName, status]),
    ).toEqual([
      ["mcp__sapiom-managed-agent-spike__echo_nonce", "success"],
      ["mcp__sapiom-managed-agent-spike__fail_once", "error"],
      ["mcp__sapiom-managed-agent-spike__fail_once", "success"],
    ]);

    const mismatch = createManagedAgentMcpRuntime("expected-nonce");
    await expect(
      mismatch.handlers.echoNonce({ nonce: "wrong-nonce" }),
    ).resolves.toMatchObject({ isError: true });
    expect(mismatch.invocations).toEqual([
      {
        toolName: "mcp__sapiom-managed-agent-spike__echo_nonce",
        status: "error",
      },
    ]);
  });

  it("passes the strict isolated SDK contract and emits only normalized evidence", async () => {
    const { config, fixture } = await probeConfig();
    const observer = fakeObserver();
    const close = vi.fn();
    let capturedOptions: Options | undefined;
    let capturedPrompt: string | undefined;
    const previousOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-user-login";
    try {
      const result = await runManagedAgentProbe(config, {
        hermeticGatewayOrigin: config.gatewayOrigin,
        processObserver: observer,
        uuid: (() => {
          let counter = 0;
          return () =>
            `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
        })(),
        queryFactory: ({ prompt, options }) => {
          capturedOptions = options;
          capturedPrompt = prompt;
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "system",
                subtype: "init",
                session_id: SUCCESS_SESSION_ID,
                model: resolveManagedAgentModelTarget("sonnet-5").alias,
              };
              yield {
                type: "assistant",
                session_id: SUCCESS_SESSION_ID,
                message: {
                  id: "message-runtime-1",
                  content: [
                    {
                      type: "tool_use",
                      id: "tool-1",
                      name: "Read",
                      input: {
                        file_path: FIXTURE_PATHS.cleanTarget,
                        secret: fixture.nonce,
                      },
                    },
                  ],
                },
              };
              await invokePreToolUse(options, {
                toolName: "Read",
                toolInput: {
                  file_path: FIXTURE_PATHS.cleanTarget,
                  secret: fixture.nonce,
                },
                toolUseId: "tool-1",
              });
              yield {
                type: "user",
                session_id: SUCCESS_SESSION_ID,
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "tool-1",
                      content: `secret:${fixture.nonce}`,
                    },
                  ],
                },
              };
              yield {
                type: "result",
                subtype: "success",
                is_error: false,
                session_id: SUCCESS_SESSION_ID,
                result: `secret:${fixture.nonce}`,
                num_turns: 1,
                usage: { input_tokens: 9, output_tokens: 4 },
              };
            },
            close,
          };
        },
      });

      expect(capturedOptions).toBeDefined();
      expect(capturedOptions?.model).toBe(
        resolveManagedAgentModelTarget("sonnet-5").alias,
      );
      expect(capturedOptions?.tools).toEqual(MANAGED_AGENT_BUILTIN_TOOLS);
      expect(capturedOptions?.disallowedTools).toEqual(
        MANAGED_AGENT_DISALLOWED_TOOLS,
      );
      expect(capturedOptions?.permissionMode).toBe("default");
      expect(capturedOptions?.settingSources).toEqual([]);
      expect(capturedOptions?.strictMcpConfig).toBe(true);
      expect(capturedOptions?.canUseTool).toBeTypeOf("function");
      expect(capturedOptions?.hooks?.PreToolUse).toHaveLength(1);
      expect(capturedOptions?.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
      expect(
        Object.prototype.hasOwnProperty.call(
          capturedOptions?.hooks?.PreToolUse?.[0] ?? {},
          "matcher",
        ),
      ).toBe(false);
      expect(capturedOptions?.spawnClaudeCodeProcess).toBeTypeOf("function");
      expect(
        Object.prototype.hasOwnProperty.call(capturedOptions, "allowedTools"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(capturedOptions, "fallbackModel"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(
          capturedOptions,
          "allowDangerouslySkipPermissions",
        ),
      ).toBe(false);
      for (const variable of MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES) {
        expect(capturedOptions?.env?.[variable]).toBe(capturedOptions?.model);
      }
      expect(capturedOptions?.env).not.toHaveProperty(
        "CLAUDE_CODE_OAUTH_TOKEN",
      );
      expect(capturedOptions?.env).not.toHaveProperty("SAPIOM_API_KEY");
      expect(result.terminal).toBe("success");
      expect(result.terminationEvidence).toEqual({
        beforePolicyOverride: "success",
        queryExecution: "iteration_completed",
        sdkResult: "success",
      });
      expect(result.policyHookCoverage).toBe(true);
      expect(result.policyDiagnostics).toEqual([]);
      expect(result.inferenceTurns).toBe(1);
      expect(result.sdkNumTurns).toBe(1);
      expect(result.correlation.promptEmbedded).toBe(true);
      expect(result.l1Certification).toEqual({
        contractVersion: 2,
        promptVersion: "managed-agent-l1-prompt-v2",
      });
      expect(result.l1FinalBytes).toEqual([
        { role: "clean_target", matched: false },
        { role: "managed_output", matched: false },
      ]);
      expect(result.nonceVerified).toBe(false);
      expect(capturedPrompt).toContain(
        "SAPIOM_CERTIFICATION_CORRELATION_V1;eval_source=studio-managed-agent-e0-l1-sonnet-5-00000000-0000-4000-8000-000000000002;execution_id=00000000-0000-4000-8000-000000000002",
      );
      expect(capturedPrompt).toContain("Do not repeat it");
      expect(result.sdkSessionId).toBe(SUCCESS_SESSION_ID);
      expect(result.queryClosed).toBe(true);
      expect(result.preservation.every(({ preserved }) => preserved)).toBe(
        true,
      );
      expect(close).toHaveBeenCalledOnce();
      expect(observer.dispose).toHaveBeenCalledOnce();
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("dedicated-eval-secret");
      expect(serialized).not.toContain(fixture.nonce);
      expect(serialized).not.toContain(fixture.outsideSentinel);
    } finally {
      if (previousOAuth === undefined)
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOAuth;
    }
  });

  it("returns recursively immutable evidence after observer finalization", async () => {
    const { config } = await probeConfig();
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      queryFactory: () =>
        queryFromEvents([
          {
            type: "system",
            subtype: "init",
            session_id: SUCCESS_SESSION_ID,
          },
          { type: "result", subtype: "success", is_error: false },
        ]),
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.teardown)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(Object.isFrozen(result.correlation)).toBe(true);
  });

  it("does not follow pre-existing config child symlinks and fails invalid roots before query construction", async () => {
    const { config, fixture } = await probeConfig();
    const externalConfig = join(fixture.root, "external-config");
    await mkdir(externalConfig);
    await symlink(externalConfig, join(fixture.configRoot, "claude-config"));
    let claudeConfigDirectory: string | undefined;
    const safeQueryFactory = vi.fn(({ options }: { options: Options }) => {
      claudeConfigDirectory = options.env?.CLAUDE_CONFIG_DIR;
      return queryFromEvents([
        {
          type: "system",
          subtype: "init",
          session_id: SUCCESS_SESSION_ID,
        },
        { type: "result", subtype: "success", is_error: false },
      ]);
    });

    await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      queryFactory: safeQueryFactory,
    });

    expect(safeQueryFactory).toHaveBeenCalledOnce();
    expect(claudeConfigDirectory).toBeDefined();
    expect(await realpath(claudeConfigDirectory!)).not.toBe(
      await realpath(externalConfig),
    );
    expect(dirname(dirname(claudeConfigDirectory!))).toBe(fixture.configRoot);
    expect((await lstat(claudeConfigDirectory!)).isSymbolicLink()).toBe(false);

    const invalidConfigRoot = join(fixture.root, "config-file");
    await writeFile(invalidConfigRoot, "not a directory");
    const rejectedQueryFactory = vi.fn(() => queryFromEvents([]));
    await expect(
      runManagedAgentProbe(
        { ...config, configRoot: invalidConfigRoot },
        {
          hermeticGatewayOrigin: config.gatewayOrigin,
          processObserver: fakeObserver(),
          queryFactory: rejectedQueryFactory,
        },
      ),
    ).rejects.toThrow("configRoot must be a directory");
    expect(rejectedQueryFactory).not.toHaveBeenCalled();
  });

  it("fails before query creation when isolated managed settings disable hooks", async () => {
    const { config } = await probeConfig();
    const queryFactory = vi.fn(() => queryFromEvents([]));
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      queryFactory,
      policySettingsGuard: async ({ environment }) => {
        expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
        expect(environment).not.toHaveProperty("ANTHROPIC_BASE_URL");
        expect(environment).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
        expect(environment).toHaveProperty("CLAUDE_CONFIG_DIR");
        throw new Error("disableAllHooks");
      },
    });

    expect(queryFactory).not.toHaveBeenCalled();
    expect(result.terminal).toBe("policy_violation");
    expect(result.terminationEvidence).toEqual({
      beforePolicyOverride: "incomplete",
      queryExecution: "not_started",
      sdkResult: "not_observed",
    });
    expect(result.policyHookCoverage).toBe(false);
    expect(result.queryClosed).toBe(false);
    expect(result.correlation.promptEmbedded).toBe(false);
    expect(result.workspaceChanges).toEqual([]);
    expect(
      result.events.filter(({ type }) => type === "terminal"),
    ).toHaveLength(1);
  });

  it("records prompt delivery when the query factory receives it and throws", async () => {
    const { config } = await probeConfig();
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      policySettingsGuard: async () => undefined,
      queryFactory: () => {
        throw new Error("synthetic query construction failure");
      },
    });

    expect(result.correlation.promptEmbedded).toBe(true);
    expect(result.queryClosed).toBe(false);
    expect(result.terminal).toBe("query_error");
    expect(result.terminationEvidence).toEqual({
      beforePolicyOverride: "query_error",
      queryExecution: "construction_failed",
      sdkResult: "not_observed",
    });
  });

  it("distinguishes query iteration failure from construction failure", async () => {
    const { config } = await probeConfig();
    const observer = fakeObserver();
    const shutdownOrder: string[] = [];
    observer.emergencyCleanup.mockImplementation(async () => {
      shutdownOrder.push("host_fallback");
      return { ...quiescentTeardown(), emergencyCleanupAttempted: true };
    });
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      policySettingsGuard: async () => undefined,
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: SUCCESS_SESSION_ID,
          };
          throw new Error("synthetic private iteration failure");
        },
        close: vi.fn(() => {
          expect(options.abortController?.signal.aborted).toBe(true);
          shutdownOrder.push("sdk_query_close");
        }),
      }),
    });

    expect(result.terminal).toBe("query_error");
    expect(result.terminationEvidence).toEqual({
      beforePolicyOverride: "query_error",
      queryExecution: "iteration_failed",
      sdkResult: "not_observed",
    });
    expect(JSON.stringify(result)).not.toContain(
      "synthetic private iteration failure",
    );
    expect(shutdownOrder).toEqual(["sdk_query_close", "host_fallback"]);
  });

  it("reports a completed iteration that emitted no SDK result", async () => {
    const { config } = await probeConfig();
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      policySettingsGuard: async () => undefined,
      queryFactory: () => queryFromEvents([]),
    });

    expect(result.terminal).toBe("incomplete");
    expect(result.terminationEvidence).toEqual({
      beforePolicyOverride: "incomplete",
      queryExecution: "iteration_completed",
      sdkResult: "not_observed",
    });
  });

  it("preserves teardown failure priority when policy preflight fails", async () => {
    const { config } = await probeConfig();
    const observer = fakeObserver({
      quiescent: false,
      deadlineMet: false,
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: false,
      forceKillIssued: false,
      toolProcessObservationComplete: true,
      toolProcessChannelsClosed: true,
      elapsedMs: 5_001,
      observedPids: [8001],
      alivePidsAtDeadline: [8001],
      emergencyCleanupAttempted: false,
    });
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      queryFactory: vi.fn(() => queryFromEvents([])),
      policySettingsGuard: async () => {
        throw new Error("disableAllHooks");
      },
    });

    expect(result.terminal).toBe("teardown_timeout");
    expect(result.events.at(-1)).toMatchObject({
      type: "terminal",
      terminal: "teardown_timeout",
    });
    expect(observer.emergencyCleanup).toHaveBeenCalledOnce();
  });

  it("rejects a successful stream when a requested tool has no primary hook decision", async () => {
    const { config } = await probeConfig();
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      policySettingsGuard: async () => undefined,
      queryFactory: () =>
        queryFromEvents([
          {
            type: "assistant",
            message: {
              id: "message-with-disabled-hook",
              content: [
                {
                  type: "tool_use",
                  id: "tool-with-disabled-hook",
                  name: "Read",
                  input: { file_path: FIXTURE_PATHS.cleanTarget },
                },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            num_turns: 1,
          },
        ]),
    });

    expect(result.policyHookCoverage).toBe(false);
    expect(result.terminal).toBe("policy_violation");
    expect(result.permissionEvidence).toEqual([]);
    expect(result.policyDiagnostics).toEqual([
      {
        kind: "missing_pre_tool_use_callback",
        reason: "no_callback_observed",
        toolName: "Read",
        correlatedRequest: true,
      },
    ]);
    expect(result.terminationEvidence).toEqual({
      beforePolicyOverride: "success",
      queryExecution: "iteration_completed",
      sdkResult: "success",
    });
  });

  it("cannot certify a malformed SDK tool-use identifier as policy-covered evidence", async () => {
    const { config } = await probeConfig();
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      policySettingsGuard: async () => undefined,
      queryFactory: () =>
        queryFromEvents([
          {
            type: "assistant",
            message: {
              id: "message-with-missing-tool-id",
              content: [
                {
                  type: "tool_use",
                  name: "Read",
                  input: { file_path: FIXTURE_PATHS.cleanTarget },
                },
              ],
            },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            num_turns: 1,
          },
        ]),
    });

    expect(result.correlation.promptEmbedded).toBe(true);
    expect(result.toolEvidence).toEqual([]);
    expect(result.permissionEvidence).toEqual([]);
    expect(result.policyHookCoverage).toBe(false);
    expect(result.terminal).toBe("policy_violation");
    expect(result.terminationEvidence).toEqual({
      beforePolicyOverride: "query_error",
      queryExecution: "event_normalization_failed",
      sdkResult: "not_observed",
      eventNormalizationFailure: "tool_request_id_invalid",
    });
  });

  it("reports a correlated PreToolUse guard rejection without certifying coverage", async () => {
    const { config } = await probeConfig();
    const requestIdSecret = "guarded-request-id-secret";
    const callbackIdSecret = "mismatched-callback-id-secret";
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      policySettingsGuard: async () => undefined,
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: {
              id: "guard-rejection-message",
              content: [
                {
                  type: "tool_use",
                  id: requestIdSecret,
                  name: "Edit",
                  input: { file_path: FIXTURE_PATHS.cleanTarget },
                },
              ],
            },
          };
          await invokePreToolUse(options, {
            toolName: "Edit",
            toolInput: { file_path: FIXTURE_PATHS.cleanTarget },
            toolUseId: requestIdSecret,
            callbackToolUseId: callbackIdSecret,
          });
          yield {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: requestIdSecret,
                  is_error: true,
                },
              ],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            num_turns: 1,
          };
        },
        close: vi.fn(),
      }),
    });

    expect(result.permissionEvidence).toEqual([]);
    expect(result.policyDiagnostics).toEqual([
      {
        kind: "pre_tool_use_guard_rejection",
        reason: "callback_tool_use_id_mismatch",
        toolName: "Edit",
        correlatedRequest: true,
      },
    ]);
    expect(result.policyHookCoverage).toBe(false);
    expect(result.terminal).toBe("policy_violation");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(requestIdSecret);
    expect(serialized).not.toContain(callbackIdSecret);
  });

  it("rejects duplicate requested tool ids instead of reusing one policy decision", async () => {
    const { config } = await probeConfig();
    const duplicateToolUseId = "duplicate-tool-use-id";
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      policySettingsGuard: async () => undefined,
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: {
              id: "duplicate-tool-message-1",
              content: [
                {
                  type: "tool_use",
                  id: duplicateToolUseId,
                  name: "Read",
                  input: { file_path: FIXTURE_PATHS.cleanTarget },
                },
              ],
            },
          };
          await invokePreToolUse(options, {
            toolName: "Read",
            toolInput: { file_path: FIXTURE_PATHS.cleanTarget },
            toolUseId: duplicateToolUseId,
          });
          yield {
            type: "assistant",
            message: {
              id: "duplicate-tool-message-2",
              content: [
                {
                  type: "tool_use",
                  id: duplicateToolUseId,
                  name: "Bash",
                  input: { command: "touch must-not-inherit-allow" },
                },
              ],
            },
          };
          await invokePreToolUse(options, {
            toolName: "Bash",
            toolInput: { command: "touch must-not-inherit-allow" },
            toolUseId: duplicateToolUseId,
          });
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            num_turns: 2,
          };
        },
        close: vi.fn(),
      }),
    });

    expect(result.permissionEvidence).toHaveLength(1);
    expect(result.policyHookCoverage).toBe(false);
    expect(result.terminal).toBe("policy_violation");
  });

  it("redacts malicious SDK and permission identifiers from the complete result", async () => {
    const { config } = await probeConfig();
    const sessionSecret = "session-secret-injected-by-sdk";
    const toolIdSecret = "tool-id-secret-injected-by-sdk";
    const toolNameSecret = "ReadSecretInjectedBySdk";
    const permissionIdSecret = "permission-id-secret-injected-by-sdk";
    const permissionNameSecret = "PermissionSecretInjectedBySdk";
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionSecret,
          };
          yield {
            type: "assistant",
            session_id: sessionSecret,
            message: {
              id: permissionIdSecret,
              content: [
                {
                  type: "tool_use",
                  id: toolIdSecret,
                  name: toolNameSecret,
                  input: { secret: "tool-input-secret" },
                },
              ],
            },
          };
          await invokePreToolUse(options, {
            toolName: permissionNameSecret,
            toolInput: { secret: "tool-input-secret" },
            toolUseId: toolIdSecret,
          });
          yield {
            type: "user",
            session_id: sessionSecret,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolIdSecret,
                  content: "tool-result-secret",
                },
              ],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sessionSecret,
            num_turns: 1,
          };
        },
        close: vi.fn(),
      }),
    });

    expect(result.sdkSessionId).toBeUndefined();
    expect(result.toolEvidence.slice(0, 2)).toMatchObject([
      { toolName: "unknown", status: "requested" },
      { toolName: "unknown", status: "success" },
    ]);
    expect(result.toolEvidence[0]?.toolUseId).toBe(
      result.toolEvidence[1]?.toolUseId,
    );
    expect(result.permissionEvidence).toMatchObject([
      {
        toolName: "unknown",
        decision: "deny",
        reason: "tool_not_allowed",
        source: "pre_tool_use",
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of [
      sessionSecret,
      toolIdSecret,
      toolNameSecret,
      permissionIdSecret,
      permissionNameSecret,
      "tool-input-secret",
      "tool-result-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("classifies an explicit active-run abort as cancellation", async () => {
    const { config } = await probeConfig("L2");
    const observer = fakeObserver();
    const close = vi.fn();
    let capturedOptions: Options | undefined;
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      waitForCancellationSignal: async () => undefined,
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          capturedOptions = options;
          yield {
            type: "system",
            subtype: "init",
            session_id: CANCEL_SESSION_ID,
          };
          if (!options.abortController?.signal.aborted) {
            await new Promise<void>((resolveAbort) =>
              options.abortController?.signal.addEventListener(
                "abort",
                () => resolveAbort(),
                { once: true },
              ),
            );
          }
          throw new Error("synthetic abort");
        },
        close,
      }),
    });

    expect(result.terminal).toBe("cancelled");
    expect(result.cancellationRequested).toBe(true);
    expect(result.queryClosed).toBe(true);
    expect(capturedOptions?.tools).toEqual(["Bash"]);
    expect(capturedOptions?.disallowedTools).toEqual(
      expect.arrayContaining(["Read", "Edit", "Write"]),
    );
    expect(capturedOptions?.mcpServers).toEqual({});
    expect(
      result.events.filter(({ type }) => type === "terminal"),
    ).toHaveLength(1);
  });

  it("keeps armed L2 readiness alive after an early query failure before aborting the SDK", async () => {
    const { config } = await probeConfig("L2");
    const observer = fakeObserver();
    let now = 1_000;
    let readinessCompleted = false;
    let readinessWasAborted = false;
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      monotonicNow: () => now,
      waitForCancellationSignal: (signal) =>
        new Promise<void>((resolveReadiness, rejectReadiness) => {
          const timer = setTimeout(() => {
            now = 3_250;
            readinessCompleted = true;
            resolveReadiness();
          }, 25);
          signal.addEventListener(
            "abort",
            () => {
              if (!readinessCompleted) readinessWasAborted = true;
              clearTimeout(timer);
              rejectReadiness(
                new Error("readiness aborted before registration"),
              );
            },
            { once: true },
          );
        }),
      queryFactory: ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: CANCEL_SESSION_ID,
          };
          await invokePreToolUse(options, {
            toolName: "Bash",
            toolInput: { command: config.allowedBashCommands[0] },
            toolUseId: "toolu_early_query_failure",
          });
          throw new Error("synthetic early query failure");
        },
        close: vi.fn(),
      }),
    });

    expect(readinessCompleted).toBe(true);
    expect(readinessWasAborted).toBe(false);
    expect(observer.armToolProcessContainment).toHaveBeenCalledOnce();
    expect(observer.emergencyCleanup).toHaveBeenCalledWith({
      startedAtMs: 1_000,
      deadlineAtMs: 6_000,
    });
    expect(result.teardown.elapsedMs).toBe(2_250);
    expect(result.cancellationRequested).toBe(false);
    expect(result.terminationEvidence.beforePolicyOverride).toBe("query_error");
  }, 10_000);

  it("awaits async-generator cleanup after void close before host fallback", async () => {
    const { config } = await probeConfig("L2");
    const observer = fakeObserver();
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    let resolveReturn!: () => void;
    const returned = new Promise<void>((resolve) => {
      resolveReturn = resolve;
    });
    let markToolArmed!: () => void;
    const toolArmed = new Promise<void>((resolve) => {
      markToolArmed = resolve;
    });
    let markCloseCalled!: () => void;
    const closeCalled = new Promise<void>((resolve) => {
      markCloseCalled = resolve;
    });
    const returnCleanup = vi.fn(async () => {
      await returned;
      return { done: true as const, value: undefined };
    });
    const close = vi.fn(() => markCloseCalled());
    let nextCall = 0;

    const resultPromise = runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      waitForCancellationSignal: async () => cancellation,
      queryFactory: ({ options }) => ({
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              nextCall += 1;
              if (nextCall === 1) {
                return {
                  done: false,
                  value: {
                    type: "assistant",
                    message: {
                      id: "assistant_cleanup_order",
                      content: [
                        {
                          type: "tool_use",
                          id: "toolu_cleanup_order",
                          name: "Bash",
                          input: { command: config.allowedBashCommands[0] },
                        },
                      ],
                    },
                  },
                };
              }
              await invokePreToolUse(options, {
                toolName: "Bash",
                toolInput: { command: config.allowedBashCommands[0] },
                toolUseId: "toolu_cleanup_order",
              });
              markToolArmed();
              return new Promise<IteratorResult<unknown>>(() => undefined);
            },
            return: returnCleanup,
          };
        },
        close,
        return: returnCleanup,
      }),
    });

    await toolArmed;
    resolveCancellation();
    await closeCalled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnStartedBeforeRelease = returnCleanup.mock.calls.length === 1;
    const fallbackStartedBeforeRelease =
      observer.emergencyCleanup.mock.calls.length > 0;
    resolveReturn();
    const result = await resultPromise;

    expect(close).toHaveBeenCalledOnce();
    expect(returnStartedBeforeRelease).toBe(true);
    expect(fallbackStartedBeforeRelease).toBe(false);
    expect(observer.emergencyCleanup).toHaveBeenCalledOnce();
    expect(result.queryClosed).toBe(true);
    expect(result.terminal).toBe("cancelled");
    expect(result.cancellationRequested).toBe(true);
  }, 10_000);

  it.each([
    ["clean completion", false, "incomplete", undefined],
    ["SDK error-result completion", true, "sdk_result_error", undefined],
    [
      "clean completion with a live process",
      false,
      "teardown_timeout",
      "liveness",
    ],
    [
      "SDK error-result completion with an open tool channel",
      true,
      "teardown_timeout",
      "channel",
    ],
  ] as const)(
    "retains armed L2 readiness and one deadline after %s",
    async (_description, emitErrorResult, expectedTerminal, failClosedOn) => {
      const { config } = await probeConfig("L2");
      const observer = fakeObserver(
        failClosedOn
          ? {
              ...quiescentTeardown(),
              quiescent: false,
              deadlineMet: false,
              toolProcessChannelsClosed: failClosedOn !== "channel",
              observedPids: failClosedOn === "liveness" ? [7_001] : [],
              alivePidsAtDeadline: failClosedOn === "liveness" ? [7_001] : [],
            }
          : quiescentTeardown(),
      );
      let now = 1_000;
      let readinessCompleted = false;
      let readinessWasAborted = false;
      let capturedOptions: Options | undefined;

      const result = await runManagedAgentProbe(config, {
        hermeticGatewayOrigin: config.gatewayOrigin,
        processObserver: observer,
        monotonicNow: () => now,
        waitForCancellationSignal: (signal) =>
          new Promise<void>((resolveReadiness, rejectReadiness) => {
            const timer = setTimeout(() => {
              now = 3_250;
              readinessCompleted = true;
              resolveReadiness();
            }, 25);
            signal.addEventListener(
              "abort",
              () => {
                if (!readinessCompleted) readinessWasAborted = true;
                clearTimeout(timer);
                rejectReadiness(
                  new Error("readiness aborted after early completion"),
                );
              },
              { once: true },
            );
          }),
        queryFactory: ({ options }) => ({
          async *[Symbol.asyncIterator]() {
            capturedOptions = options;
            yield {
              type: "assistant",
              message: {
                id: "assistant_early_settlement",
                content: [
                  {
                    type: "tool_use",
                    id: "toolu_early_settlement",
                    name: "Bash",
                    input: { command: config.allowedBashCommands[0] },
                  },
                ],
              },
            };
            await invokePreToolUse(options, {
              toolName: "Bash",
              toolInput: { command: config.allowedBashCommands[0] },
              toolUseId: "toolu_early_settlement",
            });
            if (emitErrorResult) {
              yield {
                type: "result",
                subtype: "error_max_turns",
                is_error: true,
                num_turns: 1,
              };
            }
          },
          close: vi.fn(),
        }),
      });

      expect(readinessCompleted).toBe(true);
      expect(readinessWasAborted).toBe(false);
      expect(capturedOptions?.abortController?.signal.aborted).toBe(true);
      expect(observer.emergencyCleanup).toHaveBeenCalledWith({
        startedAtMs: 1_000,
        deadlineAtMs: 6_000,
      });
      expect(result.teardown.elapsedMs).toBe(2_250);
      expect(result.queryClosed).toBe(true);
      expect(result.cancellationRequested).toBe(false);
      expect(result.terminal).toBe(expectedTerminal);
      expect(result.terminationEvidence.beforePolicyOverride).toBe(
        expectedTerminal,
      );
      if (failClosedOn === "liveness") {
        expect(result.teardown.alivePidsAtDeadline).toEqual([7_001]);
      }
      if (failClosedOn === "channel") {
        expect(result.teardown.toolProcessChannelsClosed).toBe(false);
      }
    },
    10_000,
  );

  it("abandons a never-resolving iterator next immediately after raw cancellation", async () => {
    const { config } = await probeConfig("L2");
    const observer = fakeObserver();
    const close = vi.fn();
    let markNextStarted: (() => void) | undefined;
    const nextStarted = new Promise<void>((resolveStarted) => {
      markNextStarted = resolveStarted;
    });
    const resultPromise = runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      waitForCancellationSignal: async () => undefined,
      queryFactory: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              markNextStarted?.();
              return new Promise<IteratorResult<unknown>>(() => undefined);
            },
            return: async () => ({ done: true, value: undefined }),
          };
        },
        close,
      }),
    });

    await nextStarted;
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("probe stayed blocked on iterator.next()")),
          2_000,
        ),
      ),
    ]);

    expect(result.terminal).toBe("cancelled");
    expect(result.terminationEvidence.queryExecution).toBe("iteration_aborted");
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts an awaited close promise when no iterator return exists", async () => {
    const { config } = await probeConfig();
    const close = vi.fn(async () => undefined);
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: fakeObserver(),
      queryFactory: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true as const, value: undefined }),
          };
        },
        close,
      }),
    });

    expect(close).toHaveBeenCalledOnce();
    expect(result.queryClosed).toBe(true);
    expect(result.terminationEvidence.queryExecution).toBe(
      "iteration_completed",
    );
  });

  it("keeps a CLI-shaped process alive until bounded close and cleanup complete", async () => {
    const { config } = await probeConfig("L2");
    const childProgram = String.raw`
const { runManagedAgentProbe } = await import(
  process.env.SAPIOM_TEST_RUNTIME_MODULE_URL
);
const config = JSON.parse(process.env.SAPIOM_TEST_PROBE_CONFIG);
let cleanupCalled = false;
const teardown = {
  quiescent: true,
  deadlineMet: true,
  processTableAvailable: true,
  containmentSupported: true,
  ownershipProven: true,
  forceKillIssued: true,
  toolProcessObservationComplete: true,
  toolProcessChannelsClosed: true,
  elapsedMs: 0,
  observedPids: [],
  alivePidsAtDeadline: [],
  emergencyCleanupAttempted: false,
};
const observer = {
  spawn() { throw new Error("fake query must not spawn"); },
  beginTeardown() {},
  armToolProcessContainment() {},
  async prepareCancellation() {
    return {
      supported: true,
      reason: "ready",
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: true,
      observedPids: [],
    };
  },
  async observeProcessTree() { return true; },
  async waitForQuiescence() { return teardown; },
  async emergencyCleanup() {
    cleanupCalled = true;
    return { ...teardown, emergencyCleanupAttempted: true };
  },
  dispose() {},
};
const result = await runManagedAgentProbe(config, {
  hermeticGatewayOrigin: config.gatewayOrigin,
  processObserver: observer,
  policySettingsGuard: async () => undefined,
  waitForCancellationSignal: async () => undefined,
  queryFactory: () => ({
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => undefined) };
    },
    close: () => new Promise(() => undefined),
  }),
});
process.stdout.write(JSON.stringify({
  cleanupCalled,
  queryClosed: result.queryClosed,
  terminal: result.terminal,
}));
`;
    const startedAt = Date.now();
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childProgram],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          SAPIOM_TEST_PROBE_CONFIG: JSON.stringify(config),
          SAPIOM_TEST_RUNTIME_MODULE_URL: new URL(
            "./runtime.ts",
            import.meta.url,
          ).href,
        },
        timeout: 8_000,
        killSignal: "SIGKILL",
      },
    );

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
    expect(JSON.parse(stdout)).toEqual({
      cleanupCalled: true,
      queryClosed: false,
      terminal: "close_timeout",
    });
  }, 10_000);

  it("includes iterator abandonment and close in the one cancellation deadline", async () => {
    const { config } = await probeConfig("L2");
    let now = 1_000;
    const observer = fakeObserver();
    const close = vi.fn(async () => {
      now = 3_250;
    });
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      monotonicNow: () => now,
      waitForCancellationSignal: async () => undefined,
      queryFactory: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => undefined),
          };
        },
        close,
      }),
    });

    expect(observer.emergencyCleanup).toHaveBeenCalledWith({
      startedAtMs: 1_000,
      deadlineAtMs: 6_000,
    });
    expect(result.teardown).toMatchObject({
      quiescent: true,
      deadlineMet: true,
      elapsedMs: 2_250,
    });
    expect(result.terminal).toBe("cancelled");
  });

  it("adopts the exact teardown deadline before close and iterator return", async () => {
    const { config } = await probeConfig();
    const observer = fakeObserver();
    const order: string[] = [];
    observer.beginTeardown.mockImplementation(() => {
      order.push("observer_deadline_adopted");
    });
    const close = vi.fn(() => {
      order.push("query_close");
    });
    const queryReturn = vi.fn(async () => {
      order.push("query_return");
      return { done: true as const, value: undefined };
    });

    await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      queryFactory: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true as const, value: undefined }),
          };
        },
        close,
        return: queryReturn,
      }),
    });

    expect(order).toEqual([
      "observer_deadline_adopted",
      "query_close",
      "query_return",
    ]);
    expect(observer.beginTeardown).toHaveBeenCalledOnce();
    const adoptedDeadline = observer.beginTeardown.mock.calls[0]?.[0];
    expect(observer.waitForQuiescence.mock.calls[0]?.[0]).toBe(adoptedDeadline);
  });

  it("never extends the teardown budget or reports deadline success when wall time rolls back", async () => {
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const { config } = await probeConfig("L2");
      let monotonicTime = 10_000;
      const observer = fakeObserver();
      const result = await runManagedAgentProbe(config, {
        hermeticGatewayOrigin: config.gatewayOrigin,
        processObserver: observer,
        monotonicNow: () => monotonicTime,
        waitForCancellationSignal: async () => undefined,
        queryFactory: () => ({
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => undefined),
              return: () =>
                new Promise<IteratorResult<unknown>>(() => undefined),
            };
          },
          close: () => {
            wallClock.mockReturnValue(-100_000);
            monotonicTime = 15_001;
          },
          return: () =>
            new Promise<IteratorResult<unknown, void>>(() => undefined),
        }),
      });
      const deadline = observer.emergencyCleanup.mock.calls[0]?.[0] as
        | { readonly startedAtMs: number; readonly deadlineAtMs: number }
        | undefined;

      expect(deadline).toEqual({
        startedAtMs: 10_000,
        deadlineAtMs: 15_000,
      });
      expect(deadline!.deadlineAtMs - deadline!.startedAtMs).toBe(5_000);
      expect(result.teardown.deadlineMet).toBe(false);
      expect(result.teardown.elapsedMs).toBeGreaterThanOrEqual(5_000);
    } finally {
      wallClock.mockRestore();
    }
  });

  it("records teardown failure before attempting emergency cleanup", async () => {
    const { config } = await probeConfig();
    const observer = fakeObserver({
      quiescent: false,
      deadlineMet: false,
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: false,
      forceKillIssued: false,
      toolProcessObservationComplete: true,
      toolProcessChannelsClosed: true,
      elapsedMs: 5_001,
      observedPids: [9001],
      alivePidsAtDeadline: [9001],
      emergencyCleanupAttempted: false,
    });
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      queryFactory: () =>
        queryFromEvents([
          {
            type: "system",
            subtype: "init",
            session_id: TIMEOUT_SESSION_ID,
          },
          { type: "result", subtype: "success", is_error: false },
        ]),
    });

    expect(result.terminal).toBe("teardown_timeout");
    expect(result.teardown.emergencyCleanupAttempted).toBe(true);
    expect(observer.emergencyCleanup).toHaveBeenCalledOnce();
    expect(result.events.at(-1)).toMatchObject({
      type: "terminal",
      terminal: "teardown_timeout",
    });
  });

  it("classifies a throwing query close without skipping abort or observer disposal", async () => {
    const { config } = await probeConfig();
    const observer = fakeObserver();
    let abortSignal: AbortSignal | undefined;
    const result = await runManagedAgentProbe(config, {
      hermeticGatewayOrigin: config.gatewayOrigin,
      processObserver: observer,
      queryFactory: ({ options }) => {
        abortSignal = options.abortController?.signal;
        return queryFromEvents(
          [
            {
              type: "system",
              subtype: "init",
              session_id: CLOSE_SESSION_ID,
            },
            { type: "result", subtype: "success", is_error: false },
          ],
          vi.fn(() => {
            throw new Error("synthetic close failure");
          }),
        );
      },
    });

    expect(result.terminal).toBe("close_timeout");
    expect(result.queryClosed).toBe(false);
    expect(abortSignal?.aborted).toBe(true);
    expect(observer.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a test gateway unless the explicit hermetic seam is present", async () => {
    const { config } = await probeConfig();
    const queryFactory = vi.fn(() => queryFromEvents([]));
    await expect(
      runManagedAgentProbe(config, {
        processObserver: fakeObserver(),
        queryFactory,
      }),
    ).rejects.toThrow("pinned direct Sapiom gateway origin");
    expect(queryFactory).not.toHaveBeenCalled();
  });

  it.skipIf(
    process.versions.node === MANAGED_AGENT_CONTRACT.certificationNodeVersion,
  )(
    "enforces the exact Node pin inside the exported direct-gateway runtime",
    async () => {
      const { config } = await probeConfig();
      const queryFactory = vi.fn(() => queryFromEvents([]));
      await expect(
        runManagedAgentProbe(
          {
            ...config,
            gatewayOrigin: MANAGED_AGENT_CONTRACT.directGatewayOrigin,
          },
          { processObserver: fakeObserver(), queryFactory },
        ),
      ).rejects.toThrow(
        `Direct managed-agent probes require Node ${MANAGED_AGENT_CONTRACT.certificationNodeVersion}`,
      );
      expect(queryFactory).not.toHaveBeenCalled();
    },
  );

  it("rejects the hermetic origin seam without an injected query factory", async () => {
    const { config } = await probeConfig();
    await expect(
      runManagedAgentProbe(config, {
        hermeticGatewayOrigin: config.gatewayOrigin,
        processObserver: fakeObserver(),
      }),
    ).rejects.toThrow("requires an injected queryFactory");
  });
});
