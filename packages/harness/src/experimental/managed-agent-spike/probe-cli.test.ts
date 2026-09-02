import { describe, expect, it } from "vitest";

import {
  ManagedAgentProbeCliError,
  assertManagedAgentCancellationHostPlatform,
  assertManagedAgentCertificationNodeVersion,
  evaluateManagedAgentProbe,
  executeManagedAgentProbeCli,
  managedAgentProbeUsage,
  parseManagedAgentProbeCliArgs,
} from "./probe-cli.js";
import { FIXTURE_PATHS } from "./fixture.js";
import { qualifiedManagedAgentMcpToolName } from "./runtime.js";
import type {
  ManagedAgentOperationId,
  ManagedAgentPermissionDecision,
  ManagedAgentPermissionReason,
  ManagedAgentProbeEvent,
  ManagedAgentProbeResult,
} from "./types.js";

function withProjectedL1Events(
  result: ManagedAgentProbeResult,
): ManagedAgentProbeResult {
  const events: ManagedAgentProbeEvent[] = [];
  const append = (
    event: Omit<ManagedAgentProbeEvent, "sequence" | "runId">,
  ): void => {
    events.push({
      sequence: events.length + 1,
      runId: result.runId,
      ...event,
    });
  };
  for (const evidence of result.toolEvidence) {
    if (evidence.status === "requested") {
      append({
        type: "tool_requested",
        toolUseId: evidence.toolUseId,
        toolName: evidence.toolName,
      });
      for (const decision of result.permissionEvidence.filter(
        ({ toolUseId }) => toolUseId === evidence.toolUseId,
      )) {
        append({
          type: "permission",
          toolUseId: decision.toolUseId,
          toolName: decision.toolName,
          permissionDecision: decision.decision,
          permissionReason: decision.reason,
          permissionSource: decision.source,
          operationId: decision.operationId,
        });
      }
      continue;
    }
    append({
      type: "tool_completed",
      toolUseId: evidence.toolUseId,
      toolName: evidence.toolName,
      isError: evidence.status === "error",
    });
  }
  append({ type: "sdk_result", subtype: "success", isError: false });
  append({ type: "terminal", terminal: "success" });
  return { ...result, events };
}

function withResequencedEvents(
  result: ManagedAgentProbeResult,
  events: readonly ManagedAgentProbeEvent[],
): ManagedAgentProbeResult {
  return {
    ...result,
    events: events.map((event, index) => ({
      ...event,
      sequence: index + 1,
      runId: result.runId,
    })),
  };
}

function passingL1Result(): ManagedAgentProbeResult {
  const echoTool = qualifiedManagedAgentMcpToolName("echo_nonce");
  const failOnceTool = qualifiedManagedAgentMcpToolName("fail_once");
  const steps = [
    ["Read", "success", "allow", "fixture_path", "read:clean_target"],
    ["Read", "success", "allow", "fixture_path", "read:dirty_sentinel"],
    ["Read", "success", "allow", "fixture_path", "read:untracked_sentinel"],
    [
      "Read",
      "error",
      "deny",
      "path_outside_workspace",
      "read:outside_sentinel",
    ],
    ["Read", "error", "deny", "path_symlink_escape", "read:escape_link"],
    ["Edit", "success", "allow", "fixture_path", "edit:clean_target"],
    ["Write", "success", "allow", "fixture_path", "write:managed_output"],
    [echoTool, "success", "allow", "managed_mcp_tool", "mcp:echo_nonce"],
    [failOnceTool, "error", "allow", "managed_mcp_tool", "mcp:fail_once"],
    [failOnceTool, "success", "allow", "managed_mcp_tool", "mcp:fail_once"],
    ["Bash", "success", "allow", "exact_bash_command", "bash:exact_command"],
  ] as const;
  const ids = steps.map(
    (_, index) => `tool_${(index + 1).toString(16).padStart(64, "0")}`,
  );
  return withProjectedL1Events({
    contractVersion: 1,
    runId: "run-1",
    scenario: "L1",
    target: "sonnet-5",
    modelAlias: "claude-sonnet-5-anthropic-anthropic-eval",
    sdkModelEvidence: {
      authority: "sdk_non_authoritative",
      initModelObserved: true,
      initModelMatchesExpectedAlias: true,
      resultModelUsageObserved: true,
      resultModelUsageMatchesExpectedAlias: true,
      resultModelCount: 1,
    },
    sdkSessionId: "11111111-1111-4111-8111-111111111111",
    inferenceTurns: 8,
    sdkNumTurns: 8,
    policyHookCoverage: true,
    terminal: "success",
    terminationEvidence: {
      beforePolicyOverride: "success",
      queryExecution: "iteration_completed",
      sdkResult: "success",
    },
    events: [],
    toolEvidence: steps.flatMap(([toolName, completion], index) => [
      {
        toolUseId: ids[index],
        toolName,
        status: "requested" as const,
      },
      {
        toolUseId: ids[index],
        toolName,
        status: completion,
      },
    ]),
    permissionEvidence: steps.map(
      ([toolName, , decision, reason, operationId], index) => ({
        toolUseId: ids[index]!,
        toolName,
        decision,
        reason,
        source: "pre_tool_use" as const,
        operationId,
      }),
    ),
    policyDiagnostics: [],
    workspaceChanges: [
      { path: FIXTURE_PATHS.cleanTarget, change: "modified" },
      { path: FIXTURE_PATHS.createdTarget, change: "created" },
    ],
    preservation: [
      { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
      { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
    ],
    cancellationRequested: false,
    queryClosed: true,
    teardown: {
      quiescent: true,
      deadlineMet: true,
      processTableAvailable: true,
      containmentSupported: true,
      ownershipProven: false,
      forceKillIssued: false,
      toolProcessObservationComplete: true,
      toolProcessChannelsClosed: true,
      elapsedMs: 5,
      observedPids: [],
      alivePidsAtDeadline: [],
      emergencyCleanupAttempted: false,
    },
    correlation: {
      executionId: "execution-1",
      evalSource: "eval-1",
      promptEmbedded: true,
    },
    l1Certification: {
      contractVersion: 2,
      promptVersion: "managed-agent-l1-prompt-v2",
    },
    l1FinalBytes: [
      { role: "clean_target", matched: true },
      { role: "managed_output", matched: true },
    ],
    nonceVerified: true,
  } as ManagedAgentProbeResult);
}

function passingL2Result(): ManagedAgentProbeResult {
  const base = passingL1Result();
  const toolUseId = `tool_${"c".repeat(64)}`;
  return {
    ...base,
    scenario: "L2",
    inferenceTurns: 1,
    sdkNumTurns: 1,
    terminal: "cancelled",
    events: [],
    toolEvidence: [{ toolUseId, toolName: "Bash", status: "requested" }],
    permissionEvidence: [
      {
        toolUseId,
        toolName: "Bash",
        decision: "allow",
        reason: "exact_bash_command",
        source: "pre_tool_use",
        operationId: "bash:exact_command",
      },
    ],
    workspaceChanges: [],
    cancellationRequested: true,
    teardown: {
      ...base.teardown,
      ownershipProven: true,
      forceKillIssued: true,
      observedPids: [12_345, 12_346],
    },
  };
}

function evidenceForToolId(
  result: ManagedAgentProbeResult,
  toolUseId: string,
): ManagedAgentProbeResult["toolEvidence"] {
  return result.toolEvidence.filter(
    (evidence) => evidence.toolUseId === toolUseId,
  );
}

interface TestToolStep {
  readonly toolName: string;
  readonly completion: "success" | "error";
  readonly decision: ManagedAgentPermissionDecision;
  readonly reason: ManagedAgentPermissionReason;
  readonly operationId: ManagedAgentOperationId;
}

function insertL1ToolStep(
  result: ManagedAgentProbeResult,
  beforeRequestIndex: number,
  step: TestToolStep,
  idCharacter: string,
): ManagedAgentProbeResult {
  const requested = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  );
  const nextRequest = requested[beforeRequestIndex];
  const insertionIndex = nextRequest
    ? result.toolEvidence.findIndex(
        (evidence) =>
          evidence.toolUseId === nextRequest.toolUseId &&
          evidence.status === "requested",
      )
    : result.toolEvidence.length;
  const toolUseId = `tool_${idCharacter.repeat(64)}`;
  const toolEvidence = [...result.toolEvidence];
  toolEvidence.splice(
    insertionIndex,
    0,
    { toolUseId, toolName: step.toolName, status: "requested" },
    { toolUseId, toolName: step.toolName, status: step.completion },
  );
  const permissionEvidence = [...result.permissionEvidence];
  permissionEvidence.splice(beforeRequestIndex, 0, {
    toolUseId,
    toolName: step.toolName,
    decision: step.decision,
    reason: step.reason,
    source: "pre_tool_use",
    operationId: step.operationId,
  });
  return withProjectedL1Events({
    ...result,
    toolEvidence,
    permissionEvidence,
  });
}

function optionalReadStep(
  operationId: Extract<ManagedAgentOperationId, `read:${string}`>,
): TestToolStep {
  return {
    toolName: "Read",
    completion: "success",
    decision: "allow",
    reason: "fixture_path",
    operationId,
  };
}

function expectL1TraceFailure(result: ManagedAgentProbeResult): void {
  const report = evaluateManagedAgentProbe(result);
  expect(report.outcome).toBe("fail");
  expect(report.checks).toContainEqual({
    id: "exact_l1_tool_trace",
    passed: false,
  });
}

function expectProbeCheckFailure(
  result: ManagedAgentProbeResult,
  checkId: string,
): void {
  const report = evaluateManagedAgentProbe(result);
  expect(report.outcome).toBe("fail");
  expect(report.checks).toContainEqual({ id: checkId, passed: false });
}

function maximallyBatchedL1Result(
  optionalRole?: "clean_target" | "dirty_sentinel" | "untracked_sentinel",
): ManagedAgentProbeResult {
  const withOptional = optionalRole
    ? insertL1ToolStep(
        passingL1Result(),
        5,
        optionalReadStep(`read:${optionalRole}`),
        optionalRole === "clean_target"
          ? "e"
          : optionalRole === "dirty_sentinel"
            ? "f"
            : "a",
      )
    : passingL1Result();
  const requested = withOptional.toolEvidence.filter(
    ({ status }) => status === "requested",
  );
  const completionFor = (
    request: (typeof requested)[number],
  ): (typeof withOptional.toolEvidence)[number] =>
    withOptional.toolEvidence.find(
      (evidence) =>
        evidence.toolUseId === request.toolUseId &&
        evidence.status !== "requested",
    )!;
  const optionalOffset = optionalRole ? 1 : 0;
  const phaseA = requested.slice(0, 5);
  const optional = optionalRole ? requested[5] : undefined;
  const phaseB = requested.slice(5 + optionalOffset, 9 + optionalOffset);
  const call10 = requested[9 + optionalOffset]!;
  const call11 = requested[10 + optionalOffset]!;
  const toolEvidence = [
    ...phaseA,
    ...[phaseA[2]!, phaseA[4]!, phaseA[0]!, phaseA[3]!, phaseA[1]!].map(
      completionFor,
    ),
    ...(optional ? [optional, completionFor(optional)] : []),
    ...phaseB,
    ...[phaseB[2]!, phaseB[0]!, phaseB[3]!, phaseB[1]!].map(completionFor),
    call10,
    completionFor(call10),
    call11,
    completionFor(call11),
  ];
  return withProjectedL1Events({
    ...withOptional,
    inferenceTurns: 4 + optionalOffset,
    sdkNumTurns: 4 + optionalOffset,
    toolEvidence,
  });
}

function moveCompletionAfterRequest(
  result: ManagedAgentProbeResult,
  completedRequestIndex: number,
  boundaryRequestIndex: number,
): ManagedAgentProbeResult {
  const requested = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  );
  const completedId = requested[completedRequestIndex]!.toolUseId;
  const boundaryId = requested[boundaryRequestIndex]!.toolUseId;
  const completion = result.toolEvidence.find(
    (evidence) =>
      evidence.toolUseId === completedId && evidence.status !== "requested",
  )!;
  const toolEvidence = result.toolEvidence.filter(
    (evidence) => evidence !== completion,
  );
  const boundaryIndex = toolEvidence.findIndex(
    (evidence) =>
      evidence.toolUseId === boundaryId && evidence.status === "requested",
  );
  toolEvidence.splice(boundaryIndex + 1, 0, completion);
  return withProjectedL1Events({ ...result, toolEvidence });
}

function moveCompletionBeforeOwnRequest(
  result: ManagedAgentProbeResult,
  requestIndex: number,
): ManagedAgentProbeResult {
  const request = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  )[requestIndex]!;
  const completion = result.toolEvidence.find(
    (evidence) =>
      evidence.toolUseId === request.toolUseId &&
      evidence.status !== "requested",
  )!;
  const toolEvidence = result.toolEvidence.filter(
    (evidence) => evidence !== completion,
  );
  const ownRequestIndex = toolEvidence.indexOf(request);
  toolEvidence.splice(ownRequestIndex, 0, completion);
  return withProjectedL1Events({ ...result, toolEvidence });
}

function eventSubstream(
  result: ManagedAgentProbeResult,
  types: readonly ManagedAgentProbeEvent["type"][],
): readonly Omit<ManagedAgentProbeEvent, "sequence">[] {
  return result.events
    .filter(({ type }) => types.includes(type))
    .map(({ sequence: _sequence, ...event }) => event);
}

function movePermissionAfterOwnCompletion(
  result: ManagedAgentProbeResult,
  requestIndex: number,
): ManagedAgentProbeResult {
  const request = result.toolEvidence.filter(
    ({ status }) => status === "requested",
  )[requestIndex]!;
  const events = [...result.events];
  const permissionIndex = events.findIndex(
    (event) =>
      event.type === "permission" && event.toolUseId === request.toolUseId,
  );
  const [permission] = events.splice(permissionIndex, 1);
  const completionIndex = events.findIndex(
    (event) =>
      event.type === "tool_completed" && event.toolUseId === request.toolUseId,
  );
  events.splice(completionIndex + 1, 0, permission!);
  return withResequencedEvents(result, events);
}

function withPermissionsBeforeOwnRequests(
  result: ManagedAgentProbeResult,
): ManagedAgentProbeResult {
  const events = [...result.events];
  for (const request of result.toolEvidence.filter(
    ({ status }) => status === "requested",
  )) {
    const permissionIndex = events.findIndex(
      (event) =>
        event.type === "permission" && event.toolUseId === request.toolUseId,
    );
    const [permission] = events.splice(permissionIndex, 1);
    const requestEventIndex = events.findIndex(
      (event) =>
        event.type === "tool_requested" &&
        event.toolUseId === request.toolUseId,
    );
    events.splice(requestEventIndex, 0, permission!);
  }
  return withResequencedEvents(result, events);
}

describe("managed-agent probe CLI", () => {
  it("is opt-in and never accepts credentials through arguments", () => {
    expect(() =>
      parseManagedAgentProbeCliArgs([
        "--scenario",
        "L1",
        "--target",
        "sonnet-5",
      ]),
    ).toThrow("--live");
    expect(() =>
      parseManagedAgentProbeCliArgs([
        "--live",
        "--scenario",
        "L1",
        "--target",
        "sonnet-5",
        "--api-key",
        "secret",
      ]),
    ).toThrow("Unknown argument");
    expect(managedAgentProbeUsage()).toContain("LLM_GATEWAY_EVAL_API_KEY");
    expect(managedAgentProbeUsage()).not.toContain("--api-key");
  });

  it("refuses any model outside the two-value target allowlist", () => {
    expect(() =>
      parseManagedAgentProbeCliArgs([
        "--live",
        "--scenario",
        "L1",
        "--target",
        "arbitrary-model",
      ]),
    ).toThrow("sonnet-5 or minimax-m3");
  });

  it("checks exact Node before reading a dedicated credential", async () => {
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get() {
          throw new Error("environment was read");
        },
      },
    );
    await expect(
      executeManagedAgentProbeCli(
        ["--live", "--scenario", "L1", "--target", "sonnet-5"],
        environment,
        "25.0.0",
      ),
    ).rejects.toThrow("Live probes require Node 22.23.2");
  });

  it("rejects an unexpected gateway origin before reading the eval key", async () => {
    const reads: string[] = [];
    const secret = "eval-secret-must-not-be-read";
    const environment = new Proxy<Record<string, string | undefined>>(
      {
        LLM_GATEWAY_BASE_URL: "https://llm.services.proxy.sapiom.ai",
        LLM_GATEWAY_EVAL_API_KEY: secret,
      },
      {
        get(target, property: string) {
          reads.push(property);
          return target[property];
        },
      },
    );
    let failure: unknown;
    try {
      await executeManagedAgentProbeCli(
        ["--live", "--scenario", "L1", "--target", "sonnet-5"],
        environment,
        "22.23.2",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "pinned direct Sapiom gateway origin",
    );
    expect((failure as Error).message).not.toContain(secret);
    expect(reads).toEqual(["LLM_GATEWAY_BASE_URL"]);
  });

  it("reads eval auth only after accepting the pinned direct gateway", async () => {
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      {
        LLM_GATEWAY_BASE_URL: "https://litellm.services.sapiom.ai/",
      },
      {
        get(target, property: string) {
          reads.push(property);
          return target[property];
        },
      },
    );
    await expect(
      executeManagedAgentProbeCli(
        ["--live", "--scenario", "L1", "--target", "sonnet-5"],
        environment,
        "22.23.2",
      ),
    ).rejects.toThrow("LLM_GATEWAY_EVAL_API_KEY is required");
    expect(reads).toEqual(["LLM_GATEWAY_BASE_URL", "LLM_GATEWAY_EVAL_API_KEY"]);
  });

  it("prints help without reading auth or opening a query", async () => {
    await expect(
      executeManagedAgentProbeCli(["--help"], {}, "0.0.0"),
    ).resolves.toEqual({ help: true, usage: managedAgentProbeUsage() });
  });

  it("exposes an explicit version assertion for automation", () => {
    expect(() =>
      assertManagedAgentCertificationNodeVersion("22.23.2"),
    ).not.toThrow();
    expect(() => assertManagedAgentCertificationNodeVersion("22.23.1")).toThrow(
      ManagedAgentProbeCliError,
    );
  });

  it("limits live L2 certification to the reviewed POSIX host model", () => {
    expect(() =>
      assertManagedAgentCancellationHostPlatform("darwin"),
    ).not.toThrow();
    expect(() =>
      assertManagedAgentCancellationHostPlatform("linux"),
    ).not.toThrow();
    expect(() => assertManagedAgentCancellationHostPlatform("win32")).toThrow(
      "detached POSIX fixture containment model",
    );
  });

  it("rejects Windows L2 before reading gateway or credential environment", async () => {
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get() {
          throw new Error("environment was read");
        },
      },
    );

    await expect(
      executeManagedAgentProbeCli(
        ["--live", "--scenario", "L2", "--target", "sonnet-5"],
        environment,
        "22.23.2",
        "win32",
      ),
    ).rejects.toThrow("detached POSIX fixture containment model");
  });

  it("requires successful results from every built-in tool for L1", () => {
    const passing = passingL1Result();
    const result: ManagedAgentProbeResult = {
      ...passing,
      toolEvidence: passing.toolEvidence.map((evidence) =>
        evidence.toolName === "Bash" && evidence.status === "success"
          ? { ...evidence, status: "error" }
          : evidence,
      ),
    };

    expect(
      evaluateManagedAgentProbe(result).checks.find(
        ({ id }) => id === "builtin_tools_succeeded",
      ),
    ).toEqual({ id: "builtin_tools_succeeded", passed: false });
  });

  it("fails exact-model certification when SDK-observed model evidence is missing or mixed", () => {
    const passing = passingL1Result();
    const report = evaluateManagedAgentProbe({
      ...passing,
      sdkModelEvidence: {
        ...passing.sdkModelEvidence,
        resultModelUsageMatchesExpectedAlias: false,
        resultModelCount: 2,
      },
    });

    expect(report.checks).toContainEqual({
      id: "sdk_model_alias_observed",
      passed: false,
    });
    expect(report.outcome).toBe("fail");
  });

  it.each([
    ["clean_target", "e"],
    ["dirty_sentinel", "f"],
    ["untracked_sentinel", "a"],
  ] as const)(
    "accepts one optional %s verification Read in the v2 window",
    (role, idCharacter) => {
      const passing = passingL1Result();
      const result = insertL1ToolStep(
        passing,
        5,
        optionalReadStep(`read:${role}`),
        idCharacter,
      );
      const report = evaluateManagedAgentProbe(result);

      expect(report.outcome).toBe("local_pass");
      expect(report.deploymentProvenance).toBe(
        "requires_gateway_reconciliation",
      );
      expect(report).toMatchObject({
        l1Certification: {
          contractVersion: 2,
          promptVersion: "managed-agent-l1-prompt-v2",
          evaluatorVersion: "managed-agent-l1-evaluator-v2",
          optionalReadCount: 1,
          optionalReadRole: role,
        },
      });
    },
  );

  it("records zero optional Reads as nonblocking efficiency evidence", () => {
    expect(evaluateManagedAgentProbe(passingL1Result())).toMatchObject({
      outcome: "local_pass",
      l1Certification: {
        evaluatorVersion: "managed-agent-l1-evaluator-v2",
        optionalReadCount: 0,
      },
    });
    expect(
      evaluateManagedAgentProbe(passingL1Result()).l1Certification,
    ).not.toHaveProperty("optionalReadRole");
  });

  it.each([
    ["none", undefined],
    ["clean_target", "clean_target"],
    ["dirty_sentinel", "dirty_sentinel"],
    ["untracked_sentinel", "untracked_sentinel"],
  ] as const)(
    "accepts maximally batched phase completions with %s optional Read",
    (_name, optionalRole) => {
      expect(
        evaluateManagedAgentProbe(maximallyBatchedL1Result(optionalRole)),
      ).toMatchObject({
        outcome: "local_pass",
        checks: expect.arrayContaining([
          { id: "exact_l1_tool_trace", passed: true },
        ]),
      });
    },
  );

  it("rejects the all-requests-first false-pass counterexample", () => {
    const passing = passingL1Result();
    const allRequestsFirst = withProjectedL1Events({
      ...passing,
      inferenceTurns: 1,
      sdkNumTurns: 1,
      toolEvidence: [
        ...passing.toolEvidence.filter(({ status }) => status === "requested"),
        ...passing.toolEvidence.filter(({ status }) => status !== "requested"),
      ],
    });

    expectL1TraceFailure(allRequestsFirst);
    expectProbeCheckFailure(allRequestsFirst, "minimum_l1_inference_turns");
  });

  it.each([0, 1, 2, 3, 4])(
    "rejects phase A completion %i delayed until after call 6 starts",
    (phaseAIndex) => {
      expectL1TraceFailure(
        moveCompletionAfterRequest(maximallyBatchedL1Result(), phaseAIndex, 5),
      );
    },
  );

  it.each([0, 1, 2, 3, 4])(
    "rejects phase A completion %i delayed until after the optional Read starts",
    (phaseAIndex) => {
      expectL1TraceFailure(
        moveCompletionAfterRequest(
          maximallyBatchedL1Result("clean_target"),
          phaseAIndex,
          5,
        ),
      );
    },
  );

  it.each(["clean_target", "dirty_sentinel", "untracked_sentinel"] as const)(
    "rejects the %s optional completion delayed until after call 6 starts",
    (optionalRole) => {
      expectL1TraceFailure(
        moveCompletionAfterRequest(
          maximallyBatchedL1Result(optionalRole),
          5,
          6,
        ),
      );
    },
  );

  it.each([5, 6, 7, 8])(
    "rejects phase B request-index %i completion delayed until after call 10 starts",
    (phaseBRequestIndex) => {
      expectL1TraceFailure(
        moveCompletionAfterRequest(
          maximallyBatchedL1Result(),
          phaseBRequestIndex,
          9,
        ),
      );
    },
  );

  it("rejects call 10 completion delayed until after call 11 starts", () => {
    expectL1TraceFailure(
      moveCompletionAfterRequest(maximallyBatchedL1Result(), 9, 10),
    );
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "rejects completion-before-own-request at request index %i",
    (requestIndex) => {
      expectL1TraceFailure(
        moveCompletionBeforeOwnRequest(
          maximallyBatchedL1Result(),
          requestIndex,
        ),
      );
    },
  );

  it.each([
    ["without optional Read", undefined, 3],
    ["with optional Read", "clean_target", 4],
  ] as const)(
    "rejects too few inference turns %s",
    (_name, optionalRole, inferenceTurns) => {
      expectProbeCheckFailure(
        {
          ...maximallyBatchedL1Result(optionalRole),
          inferenceTurns,
        },
        "minimum_l1_inference_turns",
      );
    },
  );

  it("rejects a normalized tool-event projection mismatch", () => {
    const passing = maximallyBatchedL1Result();
    const firstToolEvent = passing.events.findIndex(
      ({ type }) => type === "tool_requested",
    );
    const events = [...passing.events];
    events[firstToolEvent] = {
      ...events[firstToolEvent]!,
      toolName: "Write",
    };
    expectProbeCheckFailure(
      { ...passing, events },
      "normalized_event_projection",
    );
  });

  it.each(Array.from({ length: 11 }, (_, index) => index))(
    "rejects canonical permission %i moved after its own completion while preserving both substreams",
    (requestIndex) => {
      const passing = passingL1Result();
      const invalid = movePermissionAfterOwnCompletion(passing, requestIndex);

      expect(
        eventSubstream(invalid, ["tool_requested", "tool_completed"]),
      ).toEqual(eventSubstream(passing, ["tool_requested", "tool_completed"]));
      expect(eventSubstream(invalid, ["permission"])).toEqual(
        eventSubstream(passing, ["permission"]),
      );
      expectProbeCheckFailure(invalid, "normalized_event_projection");
    },
  );

  it("rejects an optional Read permission moved after its own completion while preserving both substreams", () => {
    const passing = insertL1ToolStep(
      passingL1Result(),
      5,
      optionalReadStep("read:clean_target"),
      "e",
    );
    const invalid = movePermissionAfterOwnCompletion(passing, 5);

    expect(
      eventSubstream(invalid, ["tool_requested", "tool_completed"]),
    ).toEqual(eventSubstream(passing, ["tool_requested", "tool_completed"]));
    expect(eventSubstream(invalid, ["permission"])).toEqual(
      eventSubstream(passing, ["permission"]),
    );
    expectProbeCheckFailure(invalid, "normalized_event_projection");
  });

  it("accepts permissions before their requests when each permission still precedes its completion", () => {
    const requestBeforePermission = passingL1Result();
    const permissionBeforeRequest =
      withPermissionsBeforeOwnRequests(passingL1Result());

    expect(evaluateManagedAgentProbe(requestBeforePermission).outcome).toBe(
      "local_pass",
    );
    expect(evaluateManagedAgentProbe(permissionBeforeRequest).outcome).toBe(
      "local_pass",
    );
  });

  it.each(["sdk_result", "terminal"] as const)(
    "rejects %s before the Bash completion",
    (eventType) => {
      const passing = maximallyBatchedL1Result();
      const events = [...passing.events];
      const bashCompletionIndex = events.findIndex(
        (event) => event.type === "tool_completed" && event.toolName === "Bash",
      );
      const movedIndex = events.findIndex(({ type }) => type === eventType);
      const [moved] = events.splice(movedIndex, 1);
      events.splice(bashCompletionIndex, 0, moved!);
      expectProbeCheckFailure(
        withResequencedEvents(passing, events),
        "bash_sdk_terminal_order",
      );
    },
  );

  it("rejects terminal before the successful SDK result", () => {
    const passing = maximallyBatchedL1Result();
    const events = [...passing.events];
    const sdkResultIndex = events.findIndex(
      ({ type }) => type === "sdk_result",
    );
    const terminalIndex = events.findIndex(({ type }) => type === "terminal");
    [events[sdkResultIndex], events[terminalIndex]] = [
      events[terminalIndex]!,
      events[sdkResultIndex]!,
    ];
    expectProbeCheckFailure(
      withResequencedEvents(passing, events),
      "bash_sdk_terminal_order",
    );
  });

  it("rejects a second optional verification Read", () => {
    const first = insertL1ToolStep(
      passingL1Result(),
      5,
      optionalReadStep("read:clean_target"),
      "e",
    );
    const second = insertL1ToolStep(
      first,
      6,
      optionalReadStep("read:dirty_sentinel"),
      "f",
    );

    const report = evaluateManagedAgentProbe(second);
    expect(report.l1Certification).toMatchObject({ optionalReadCount: 2 });
    expectL1TraceFailure(second);
  });

  it.each([
    ["managed_output", "e"],
    ["outside_sentinel", "f"],
    ["escape_link", "a"],
  ] as const)(
    "rejects an optional Read of the registered but disallowed %s role",
    (role, idCharacter) => {
      expectL1TraceFailure(
        insertL1ToolStep(
          passingL1Result(),
          5,
          optionalReadStep(`read:${role}`),
          idCharacter,
        ),
      );
    },
  );

  it.each([
    ["before the denial probes", 3],
    ["after Edit", 6],
  ] as const)("rejects an otherwise valid optional Read %s", (_name, index) => {
    expectL1TraceFailure(
      insertL1ToolStep(
        passingL1Result(),
        index,
        optionalReadStep("read:clean_target"),
        "e",
      ),
    );
  });

  it.each([
    ["outside denial", "path_outside_workspace", "read:outside_sentinel"],
    ["symlink denial", "path_symlink_escape", "read:escape_link"],
  ] as const)(
    "rejects an extra denied Read retry of the %s",
    (_name, reason, operationId) => {
      expectL1TraceFailure(
        insertL1ToolStep(
          passingL1Result(),
          5,
          {
            toolName: "Read",
            completion: "error",
            decision: "deny",
            reason,
            operationId,
          },
          "e",
        ),
      );
    },
  );

  it.each([
    [
      "Edit",
      {
        toolName: "Edit",
        completion: "success",
        decision: "allow",
        reason: "fixture_path",
        operationId: "edit:clean_target",
      },
    ],
    [
      "Write",
      {
        toolName: "Write",
        completion: "success",
        decision: "allow",
        reason: "fixture_path",
        operationId: "write:managed_output",
      },
    ],
    [
      "Bash",
      {
        toolName: "Bash",
        completion: "success",
        decision: "allow",
        reason: "exact_bash_command",
        operationId: "bash:exact_command",
      },
    ],
    [
      "MCP",
      {
        toolName: qualifiedManagedAgentMcpToolName("echo_nonce"),
        completion: "success",
        decision: "allow",
        reason: "managed_mcp_tool",
        operationId: "mcp:echo_nonce",
      },
    ],
    [
      "unknown tool",
      {
        toolName: "unknown",
        completion: "error",
        decision: "deny",
        reason: "tool_not_allowed",
        operationId: "unknown",
      },
    ],
  ] as const)("rejects any extra %s operation", (_name, step) => {
    expectL1TraceFailure(insertL1ToolStep(passingL1Result(), 5, step, "e"));
  });

  it("rejects any workspace delta beyond the two canonical L1 changes", () => {
    const passing = passingL1Result();
    const report = evaluateManagedAgentProbe({
      ...passing,
      workspaceChanges: [
        ...passing.workspaceChanges,
        { path: "unexpected.txt", change: "created" },
      ],
    });

    expect(report.outcome).toBe("fail");
    expect(report.checks).toContainEqual({
      id: "exact_workspace_delta",
      passed: false,
    });
  });

  it("accepts the exact workspace delta in either evidence order", () => {
    const passing = passingL1Result();
    const report = evaluateManagedAgentProbe({
      ...passing,
      workspaceChanges: [...passing.workspaceChanges].reverse(),
    });

    expect(report.outcome).toBe("local_pass");
    expect(report.checks).toContainEqual({
      id: "exact_workspace_delta",
      passed: true,
    });
  });

  it("rejects a duplicate canonical workspace entry with the other path missing", () => {
    const passing = passingL1Result();
    const duplicate = passing.workspaceChanges[0]!;
    const report = evaluateManagedAgentProbe({
      ...passing,
      workspaceChanges: [duplicate, duplicate],
    });

    expect(report.outcome).toBe("fail");
    expect(report.checks).toContainEqual({
      id: "exact_workspace_delta",
      passed: false,
    });
  });

  it("accepts exactly one permitted Bash request for L2 and rejects any extra tool call", () => {
    const passing = passingL2Result();
    expect(evaluateManagedAgentProbe(passing, [12_345, 12_346])).toMatchObject({
      outcome: "local_pass",
      checks: expect.arrayContaining([
        { id: "exact_l2_bash_only_trace", passed: true },
        { id: "l2_containment_prepared", passed: true },
      ]),
    });
    expect(
      evaluateManagedAgentProbe(passing).checks.find(
        ({ id }) => id === "no_fixture_process_alive",
      ),
    ).toEqual({ id: "no_fixture_process_alive", passed: false });

    const writeId = `tool_${"d".repeat(64)}`;
    const invalid: ManagedAgentProbeResult = {
      ...passing,
      toolEvidence: [
        ...passing.toolEvidence,
        { toolUseId: writeId, toolName: "Write", status: "requested" },
        { toolUseId: writeId, toolName: "Write", status: "success" },
      ],
      permissionEvidence: [
        ...passing.permissionEvidence,
        {
          toolUseId: writeId,
          toolName: "Write",
          decision: "allow",
          reason: "fixture_path",
          source: "pre_tool_use",
          operationId: "write:unregistered",
        },
      ],
    };

    expect(
      evaluateManagedAgentProbe(invalid, [12_345, 12_346]).checks,
    ).toContainEqual({
      id: "exact_l2_bash_only_trace",
      passed: false,
    });
  });

  it("requires observed closed tool lifetimes but not an unnecessary host force-kill", () => {
    const passing = passingL2Result();
    const graceful = {
      ...passing,
      teardown: { ...passing.teardown, forceKillIssued: false },
    };
    expect(evaluateManagedAgentProbe(graceful, [12_345, 12_346]).outcome).toBe(
      "local_pass",
    );

    for (const [field, checkId] of [
      ["toolProcessObservationComplete", "l2_containment_prepared"],
      ["toolProcessChannelsClosed", "sdk_closed_tool_lifetime_channels"],
    ] as const) {
      expect(
        evaluateManagedAgentProbe(
          {
            ...passing,
            teardown: { ...passing.teardown, [field]: false },
          },
          [12_345, 12_346],
        ).checks,
      ).toContainEqual({ id: checkId, passed: false });
    }
  });

  it("never certifies a cancelled terminal without a requested cancellation", () => {
    const passing = passingL2Result();
    const report = evaluateManagedAgentProbe(
      { ...passing, cancellationRequested: false },
      [12_345, 12_346],
    );

    expect(report.outcome).toBe("fail");
    expect(report.checks).toContainEqual({
      id: "cancellation_requested",
      passed: false,
    });
  });

  it.each([
    [
      "omitted",
      (passing: ManagedAgentProbeResult) => {
        const omittedId = passing.toolEvidence.find(
          (evidence) =>
            evidence.status === "requested" && evidence.toolName === "Read",
        )!.toolUseId!;
        return {
          ...passing,
          toolEvidence: passing.toolEvidence.filter(
            (evidence) => evidence.toolUseId !== omittedId,
          ),
          permissionEvidence: passing.permissionEvidence.filter(
            (evidence) => evidence.toolUseId !== omittedId,
          ),
        };
      },
    ],
    [
      "reordered",
      (passing: ManagedAgentProbeResult) => {
        const requested = passing.toolEvidence.filter(
          ({ status }) => status === "requested",
        );
        const editId = requested[5]!.toolUseId!;
        const writeId = requested[6]!.toolUseId!;
        const editEvidence = evidenceForToolId(passing, editId);
        const writeEvidence = evidenceForToolId(passing, writeId);
        const reordered = passing.toolEvidence.filter(
          ({ toolUseId }) => toolUseId !== editId && toolUseId !== writeId,
        );
        reordered.splice(10, 0, ...writeEvidence, ...editEvidence);
        return { ...passing, toolEvidence: reordered };
      },
    ],
    [
      "extra",
      (passing: ManagedAgentProbeResult) => {
        const toolUseId = `tool_${"a".repeat(64)}`;
        return {
          ...passing,
          toolEvidence: [
            ...passing.toolEvidence,
            { toolUseId, toolName: "Read", status: "requested" as const },
            { toolUseId, toolName: "Read", status: "success" as const },
          ],
          permissionEvidence: [
            ...passing.permissionEvidence,
            {
              toolUseId,
              toolName: "Read",
              decision: "allow" as const,
              reason: "fixture_path" as const,
              source: "pre_tool_use" as const,
              operationId: "read:clean_target" as const,
            },
          ],
        };
      },
    ],
    [
      "duplicate retry",
      (passing: ManagedAgentProbeResult) => {
        const toolUseId = `tool_${"b".repeat(64)}`;
        return {
          ...passing,
          toolEvidence: [
            ...passing.toolEvidence,
            { toolUseId, toolName: "Bash", status: "requested" as const },
            { toolUseId, toolName: "Bash", status: "success" as const },
          ],
          permissionEvidence: [
            ...passing.permissionEvidence,
            {
              toolUseId,
              toolName: "Bash",
              decision: "allow" as const,
              reason: "exact_bash_command" as const,
              source: "pre_tool_use" as const,
              operationId: "bash:exact_command" as const,
            },
          ],
        };
      },
    ],
  ])("rejects an %s L1 tool trace", (_name, mutate) => {
    const report = evaluateManagedAgentProbe(mutate(passingL1Result()));

    expect(report.outcome).toBe("fail");
    expect(report.checks).toContainEqual({
      id: "exact_l1_tool_trace",
      passed: false,
    });
  });

  describe("L1 v2 request correlation", () => {
    it("rejects duplicate request IDs", () => {
      const passing = passingL1Result();
      const requestIds = passing.toolEvidence.flatMap((evidence) =>
        evidence.status === "requested" && evidence.toolUseId
          ? [evidence.toolUseId]
          : [],
      );
      const firstId = requestIds[0]!;
      const duplicateId = requestIds[1]!;
      expectL1TraceFailure({
        ...passing,
        toolEvidence: passing.toolEvidence.map((evidence) =>
          evidence.status === "requested" && evidence.toolUseId === firstId
            ? { ...evidence, toolUseId: duplicateId }
            : evidence,
        ),
      });
    });

    it("rejects an empty request ID", () => {
      const passing = passingL1Result();
      const firstId = passing.toolEvidence.find(
        ({ status }) => status === "requested",
      )!.toolUseId!;
      expectL1TraceFailure({
        ...passing,
        toolEvidence: passing.toolEvidence.map((evidence) =>
          evidence.status === "requested" && evidence.toolUseId === firstId
            ? { ...evidence, toolUseId: "   " }
            : evidence,
        ),
      });
    });

    it("rejects a request with no completion", () => {
      const passing = passingL1Result();
      const firstId = passing.toolEvidence.find(
        ({ status }) => status === "requested",
      )!.toolUseId!;
      expectL1TraceFailure({
        ...passing,
        toolEvidence: passing.toolEvidence.filter(
          (evidence) =>
            evidence.toolUseId !== firstId || evidence.status === "requested",
        ),
      });
    });

    it("rejects duplicate completions for one request", () => {
      const passing = passingL1Result();
      const completion = passing.toolEvidence.find(
        ({ status }) => status !== "requested",
      )!;
      expectL1TraceFailure({
        ...passing,
        toolEvidence: [...passing.toolEvidence, completion],
      });
    });

    it("rejects a completion whose tool does not match its request", () => {
      const passing = passingL1Result();
      const firstId = passing.toolEvidence.find(
        ({ status }) => status === "requested",
      )!.toolUseId!;
      expectL1TraceFailure({
        ...passing,
        toolEvidence: passing.toolEvidence.map((evidence) =>
          evidence.toolUseId === firstId && evidence.status !== "requested"
            ? { ...evidence, toolName: "Write" }
            : evidence,
        ),
      });
    });

    it("rejects a request with no primary PreToolUse decision", () => {
      const passing = passingL1Result();
      const firstDecision = passing.permissionEvidence[0]!;
      expectL1TraceFailure({
        ...passing,
        permissionEvidence: passing.permissionEvidence.filter(
          ({ toolUseId }) => toolUseId !== firstDecision.toolUseId,
        ),
      });
    });

    it("rejects duplicate primary decisions for one request", () => {
      const passing = passingL1Result();
      expectL1TraceFailure({
        ...passing,
        permissionEvidence: [
          ...passing.permissionEvidence,
          passing.permissionEvidence[0]!,
        ],
      });
    });

    it("rejects a primary decision whose tool does not match its request", () => {
      const passing = passingL1Result();
      const firstDecision = passing.permissionEvidence[0]!;
      expectL1TraceFailure({
        ...passing,
        permissionEvidence: passing.permissionEvidence.map((evidence) =>
          evidence.toolUseId === firstDecision.toolUseId
            ? { ...evidence, toolName: "Write" }
            : evidence,
        ),
      });
    });

    it("rejects a fallback decision in addition to the primary decision", () => {
      const passing = passingL1Result();
      expectL1TraceFailure({
        ...passing,
        permissionEvidence: [
          ...passing.permissionEvidence,
          {
            ...passing.permissionEvidence[0]!,
            source: "can_use_tool_fallback",
          },
        ],
      });
    });

    it("rejects a fallback decision that replaces the primary decision", () => {
      const passing = passingL1Result();
      const firstDecision = passing.permissionEvidence[0]!;
      expectL1TraceFailure({
        ...passing,
        permissionEvidence: passing.permissionEvidence.map((evidence) =>
          evidence.toolUseId === firstDecision.toolUseId
            ? { ...evidence, source: "can_use_tool_fallback" }
            : evidence,
        ),
      });
    });

    it("rejects an orphan completion", () => {
      const passing = passingL1Result();
      expectL1TraceFailure({
        ...passing,
        toolEvidence: [
          ...passing.toolEvidence,
          {
            toolUseId: `tool_${"e".repeat(64)}`,
            toolName: "Read",
            status: "success",
          },
        ],
      });
    });

    it("rejects an orphan primary decision", () => {
      const passing = passingL1Result();
      expectL1TraceFailure({
        ...passing,
        permissionEvidence: [
          ...passing.permissionEvidence,
          {
            ...passing.permissionEvidence[0]!,
            toolUseId: `tool_${"e".repeat(64)}`,
          },
        ],
      });
    });
  });

  describe("L1 v2 outcome and certification evidence", () => {
    it("rejects an allowed canonical operation that completes with an error", () => {
      const passing = passingL1Result();
      const firstId = passing.toolEvidence.find(
        ({ status }) => status === "requested",
      )!.toolUseId!;
      expectL1TraceFailure({
        ...passing,
        toolEvidence: passing.toolEvidence.map((evidence) =>
          evidence.toolUseId === firstId && evidence.status === "success"
            ? { ...evidence, status: "error" }
            : evidence,
        ),
      });
    });

    it("rejects a denied canonical operation that reports success", () => {
      const passing = passingL1Result();
      const deniedId = passing.permissionEvidence.find(
        ({ decision }) => decision === "deny",
      )!.toolUseId;
      expectL1TraceFailure({
        ...passing,
        toolEvidence: passing.toolEvidence.map((evidence) =>
          evidence.toolUseId === deniedId && evidence.status === "error"
            ? { ...evidence, status: "success" }
            : evidence,
        ),
      });
    });

    it("rejects an incoherent decision, reason, or operation ID", () => {
      const passing = passingL1Result();
      const firstDecision = passing.permissionEvidence[0]!;
      for (const replacement of [
        { decision: "deny" as const },
        { reason: "path_outside_workspace" as const },
        { operationId: "read:dirty_sentinel" as const },
      ]) {
        expectL1TraceFailure({
          ...passing,
          permissionEvidence: passing.permissionEvidence.map((evidence) =>
            evidence.toolUseId === firstDecision.toolUseId
              ? { ...evidence, ...replacement }
              : evidence,
          ),
        });
      }
    });

    it("rejects missing or stale L1 v2 contract evidence", () => {
      const passing = passingL1Result();
      expectProbeCheckFailure(
        { ...passing, l1Certification: undefined },
        "l1_contract_v2",
      );
      expectProbeCheckFailure(
        {
          ...passing,
          l1Certification: {
            contractVersion: 1,
            promptVersion: "managed-agent-l1-prompt-v1",
          },
        } as unknown as ManagedAgentProbeResult,
        "l1_contract_v2",
      );
      expectProbeCheckFailure(
        {
          ...passing,
          correlation: { ...passing.correlation, promptEmbedded: false },
        },
        "l1_contract_v2",
      );
    });

    it("requires positive nonce evidence", () => {
      expectProbeCheckFailure(
        { ...passingL1Result(), nonceVerified: false },
        "nonce_verified",
      );
    });

    it.each([
      ["missing", undefined],
      [
        "false",
        [
          { role: "clean_target", matched: true },
          { role: "managed_output", matched: false },
        ],
      ],
      [
        "extra",
        [
          { role: "clean_target", matched: true },
          { role: "managed_output", matched: true },
          { role: "clean_target", matched: true },
        ],
      ],
    ] as const)("rejects %s L1 final-byte evidence", (_name, l1FinalBytes) => {
      expectProbeCheckFailure(
        {
          ...passingL1Result(),
          l1FinalBytes,
        } as ManagedAgentProbeResult,
        "expected_final_bytes",
      );
    });

    it.each([
      ["terminal success", "terminal_success", { terminal: "incomplete" }],
      ["query close", "query_closed", { queryClosed: false }],
      [
        "process quiescence",
        "process_tree_quiescent",
        { teardown: { ...passingL1Result().teardown, quiescent: false } },
      ],
    ] as const)("requires %s", (_name, checkId, mutation) => {
      expectProbeCheckFailure(
        {
          ...passingL1Result(),
          ...mutation,
        } as ManagedAgentProbeResult,
        checkId,
      );
    });

    it.each([
      ["missing", []],
      [
        "false",
        [
          { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
          { path: FIXTURE_PATHS.untrackedSentinel, preserved: false },
        ],
      ],
      [
        "extra",
        [
          { path: FIXTURE_PATHS.dirtySentinel, preserved: true },
          { path: FIXTURE_PATHS.untrackedSentinel, preserved: true },
          { path: "extra-sentinel.txt", preserved: true },
        ],
      ],
    ] as const)("rejects %s preservation evidence", (_name, preservation) => {
      expectProbeCheckFailure(
        { ...passingL1Result(), preservation: [...preservation] },
        "dirty_and_untracked_preserved",
      );
    });
  });

  it("requires one completion and primary decision per L1 request, including fail_once error then success", () => {
    const passing = passingL1Result();
    const failOnceRequests = passing.toolEvidence.filter(
      ({ status, toolName }) =>
        status === "requested" &&
        toolName === qualifiedManagedAgentMcpToolName("fail_once"),
    );
    const firstFailOnceId = failOnceRequests[0]!.toolUseId!;
    const invalid: ManagedAgentProbeResult = {
      ...passing,
      toolEvidence: passing.toolEvidence.map((evidence) =>
        evidence.toolUseId === firstFailOnceId && evidence.status === "error"
          ? { ...evidence, status: "success" }
          : evidence,
      ),
    };

    expect(evaluateManagedAgentProbe(invalid).checks).toContainEqual({
      id: "exact_l1_tool_trace",
      passed: false,
    });
  });

  it("requires positive permission evidence and distinct lexical and symlink denials", () => {
    const passing = passingL1Result();
    expect(evaluateManagedAgentProbe(passing).outcome).toBe("local_pass");

    const falsePass: ManagedAgentProbeResult = {
      ...passing,
      permissionEvidence: [
        {
          toolUseId: `tool_${"a".repeat(64)}`,
          toolName: "Read",
          decision: "deny",
          reason: "path_outside_workspace",
          source: "pre_tool_use",
          operationId: "read:outside_sentinel",
        },
        {
          toolUseId: `tool_${"b".repeat(64)}`,
          toolName: "Read",
          decision: "deny",
          reason: "path_outside_workspace",
          source: "pre_tool_use",
          operationId: "read:outside_sentinel",
        },
      ],
    };
    const checks = evaluateManagedAgentProbe(falsePass);

    expect(checks.outcome).toBe("fail");
    expect(
      checks.checks.find(({ id }) => id === "expected_permissions_allowed"),
    ).toEqual({ id: "expected_permissions_allowed", passed: false });
    expect(
      checks.checks.find(({ id }) => id === "outside_and_symlink_denied"),
    ).toEqual({ id: "outside_and_symlink_denied", passed: false });
  });
});
