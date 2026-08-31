import {
  PACKAGE_GRAPH_EVIDENCE_PROTOCOL,
  PACKAGE_INVENTORY_PROTOCOL,
  advancePackageGraphStaticEvidenceState,
  appendPackageGraphRuntimeEvidenceEvent,
  createPackageGraphEvidenceStaticResult,
  createPackageGraphRuntimeEvidenceEvent,
  packageGraphEvidenceStaticResultSchema,
  packageGraphRuntimeEvidenceEventSchema,
  projectPackageGraphEvidence,
  type PackageGraphEvidenceCandidate,
  type PackageGraphEvidenceCoverage,
  type PackageGraphEvidenceDiagnostic,
  type PackageGraphEvidenceDigest,
  type PackageGraphEvidenceProducer,
  type PackageGraphEvidenceStaticResult,
  type PackageGraphRuntimeEvidenceEvent,
  type PackageInventory,
  type PackageInventoryVersion,
} from "./index.js";
import {
  canonicalPackageGraphEvidenceJson,
  packageGraphEvidenceCandidateSchema,
  packageGraphEvidenceSha256,
} from "./package-graph-evidence.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const SHA_C = `sha256:${"c".repeat(64)}` as const;
const PRODUCER: PackageGraphEvidenceProducer = {
  id: "sapiom.static-fixture",
  version: "1.0.0",
};

function source(ref: string) {
  return { kind: "source-callsite" as const, ref };
}

function execution(ref: string) {
  return { kind: "execution" as const, ref };
}

function workingInventory(
  overrides: Partial<PackageInventory> = {},
): PackageInventory {
  return {
    protocol: PACKAGE_INVENTORY_PROTOCOL,
    version: {
      kind: "working-tree",
      workspaceKey: "workspace-acme",
      revision: SHA_A,
    },
    status: "complete",
    agents: [
      {
        agentKey: "coordinator",
        identityStatus: "canonical",
        path: "agents/coordinator",
        entrypoint: "index.ts",
      },
      {
        agentKey: "growth",
        identityStatus: "canonical",
        path: "agents/growth",
        entrypoint: "index.ts",
      },
      {
        agentKey: "research",
        identityStatus: "canonical",
        path: "agents/research",
        entrypoint: "index.ts",
      },
    ],
    ...overrides,
  };
}

function bundleInventory(
  bundleDigest: PackageGraphEvidenceDigest = SHA_B,
): PackageInventory {
  return {
    ...workingInventory(),
    version: { kind: "bundle", bundleDigest },
  };
}

function invocation(
  fromAgentKey: string,
  toAgentKey: string,
  mode: "blocking" | "async" = "blocking",
  ref = `callsite:${fromAgentKey}.${toAgentKey}`,
): PackageGraphEvidenceCandidate {
  return {
    fromAgentKey,
    toAgentKey,
    relation: "invokes",
    basis: "static-invocation",
    mode,
    callsites: [source(ref)],
  };
}

function dataflow(
  fromAgentKey: string,
  toAgentKey: string,
): PackageGraphEvidenceCandidate {
  return {
    fromAgentKey,
    toAgentKey,
    relation: "feeds",
    basis: "static-dataflow",
    source: source("callsite:research.output"),
    destination: source("callsite:growth.input"),
    path: [
      { kind: "dataflow-path", ref: "path:formatter" },
      { kind: "dataflow-path", ref: "path:router" },
    ],
  };
}

function staticResult(
  candidates: readonly unknown[],
  options: {
    inventory?: PackageInventory;
    scope?: PackageInventoryVersion;
    analysisFingerprint?: PackageGraphEvidenceDigest;
    outcome?: "success" | "failure";
    coverage?: PackageGraphEvidenceCoverage;
    diagnostics?: readonly PackageGraphEvidenceDiagnostic[];
  } = {},
): PackageGraphEvidenceStaticResult {
  const inventory = options.inventory ?? workingInventory();
  return createPackageGraphEvidenceStaticResult(
    {
      scope: options.scope ?? inventory.version,
      producer: PRODUCER,
      analysisFingerprint: options.analysisFingerprint ?? SHA_A,
      outcome: options.outcome ?? "success",
      coverage: options.coverage ?? { status: "complete" },
      candidates,
      diagnostics: options.diagnostics,
    },
    inventory,
  );
}

function acceptedRuntime(
  eventId: string,
  candidate: unknown,
  bundleDigest: PackageGraphEvidenceDigest = SHA_B,
): PackageGraphRuntimeEvidenceEvent {
  const inventory = bundleInventory(bundleDigest);
  const created = createPackageGraphRuntimeEvidenceEvent(
    {
      eventId,
      scope: { kind: "bundle", bundleDigest },
      producer: { id: "sapiom.engine", version: "1.0.0" },
      candidate,
    },
    inventory,
  );
  if (created.status !== "accepted") throw new Error("fixture was quarantined");
  return created.event;
}

describe("package graph evidence protocol 1", () => {
  it("accepts exactly the four legal relation/basis variants", () => {
    const candidates: PackageGraphEvidenceCandidate[] = [
      invocation("coordinator", "research"),
      dataflow("research", "growth"),
      {
        fromAgentKey: "coordinator",
        toAgentKey: "research",
        relation: "invokes",
        basis: "runtime-dispatch",
        callerExecution: execution("execution:coordinator"),
        calleeExecution: execution("execution:research"),
        callsite: { kind: "runtime-callsite", ref: "callsite:dispatch" },
      },
      {
        fromAgentKey: "research",
        toAgentKey: "growth",
        relation: "feeds",
        basis: "runtime-handoff",
        producerExecution: execution("execution:research"),
        consumerExecution: execution("execution:growth"),
        lineage: { kind: "lineage", ref: "lineage:report" },
      },
    ];

    expect(
      candidates.map(
        (candidate) =>
          packageGraphEvidenceCandidateSchema.parse(candidate).basis,
      ),
    ).toEqual([
      "static-invocation",
      "static-dataflow",
      "runtime-dispatch",
      "runtime-handoff",
    ]);
    expect(() =>
      packageGraphEvidenceCandidateSchema.parse({
        ...invocation("coordinator", "research"),
        relation: "feeds",
      }),
    ).toThrow();
    expect(() =>
      packageGraphEvidenceCandidateSchema.parse({
        ...candidates[2],
        mode: "async",
      }),
    ).toThrow();
  });

  it("keeps direct sibling calls distinct from indirect output data flow", () => {
    const direct = staticResult([
      invocation("coordinator", "research"),
      invocation("coordinator", "growth"),
    ]);
    const directProjection = projectPackageGraphEvidence(workingInventory(), [
      direct,
    ]);

    expect(
      directProjection.connectors.map(
        ({ fromAgentKey, toAgentKey, relation }) => [
          fromAgentKey,
          toAgentKey,
          relation,
        ],
      ),
    ).toEqual([
      ["coordinator", "growth", "invokes"],
      ["coordinator", "research", "invokes"],
    ]);
    expect(directProjection.connectors).not.toContainEqual(
      expect.objectContaining({
        fromAgentKey: "research",
        toAgentKey: "growth",
        relation: "feeds",
      }),
    );

    const withProvenFlow = staticResult([
      invocation("coordinator", "research"),
      invocation("coordinator", "growth"),
      dataflow("research", "growth"),
    ]);
    expect(
      projectPackageGraphEvidence(workingInventory(), [withProvenFlow])
        .connectors,
    ).toContainEqual(
      expect.objectContaining({
        fromAgentKey: "research",
        toAgentKey: "growth",
        relation: "feeds",
        bases: ["static-dataflow"],
      }),
    );
  });

  it("derives byte-identical records and IDs from equivalent unordered inputs", () => {
    const first = staticResult([
      {
        ...invocation("coordinator", "research"),
        callsites: [
          source("callsite:z"),
          source("callsite:a"),
          source("callsite:z"),
        ],
      },
      invocation("coordinator", "growth", "async"),
    ]);
    const second = staticResult([
      invocation("coordinator", "growth", "async"),
      {
        ...invocation("coordinator", "research"),
        callsites: [source("callsite:a"), source("callsite:z")],
      },
    ]);

    expect(canonicalPackageGraphEvidenceJson(first)).toBe(
      canonicalPackageGraphEvidenceJson(second),
    );
    expect(first.resultId).toBe(second.resultId);
    expect(first.evidence.map(({ evidenceId }) => evidenceId)).toEqual(
      second.evidence.map(({ evidenceId }) => evidenceId),
    );
  });

  it.each([
    [source("callsite:z"), source("callsite:a")],
    [source("callsite:a"), source("callsite:a"), source("callsite:z")],
  ])(
    "rejects non-normalized callsite references even when their IDs match the wire content",
    (...callsites) => {
      const canonical = staticResult([
        {
          ...invocation("coordinator", "research"),
          callsites: [source("callsite:a"), source("callsite:z")],
        },
      ]);
      const candidate = {
        ...invocation("coordinator", "research"),
        callsites,
      };
      const evidenceId = packageGraphEvidenceSha256({
        protocol: canonical.protocol,
        scope: canonical.scope,
        producer: canonical.producer,
        analysisFingerprint: canonical.analysisFingerprint,
        candidate,
      });
      const record = { ...candidate, evidenceId };
      const draft = {
        protocol: canonical.protocol,
        kind: canonical.kind,
        scope: canonical.scope,
        producer: canonical.producer,
        analysisFingerprint: canonical.analysisFingerprint,
        outcome: canonical.outcome,
        coverage: canonical.coverage,
        evidence: [record],
        diagnostics: canonical.diagnostics,
        quarantine: canonical.quarantine,
      };
      const forged = {
        ...draft,
        resultId: packageGraphEvidenceSha256(draft),
      };

      expect(() =>
        packageGraphEvidenceStaticResultSchema.parse(forged),
      ).toThrow(/unique and canonically ordered/);
    },
  );

  it("keeps analysis freshness independent from inventory identity", () => {
    const first = staticResult([invocation("coordinator", "research")]);
    const changedAnalysis = staticResult(
      [invocation("coordinator", "research")],
      { analysisFingerprint: SHA_C },
    );

    expect(changedAnalysis.scope).toEqual(first.scope);
    expect(changedAnalysis.resultId).not.toBe(first.resultId);
    expect(changedAnalysis.evidence[0]?.evidenceId).not.toBe(
      first.evidence[0]?.evidenceId,
    );
  });

  it("preserves exact provisional working-tree identities without overloading inventory status", () => {
    const inventory = workingInventory({
      status: "degraded",
      agents: [
        workingInventory().agents[0]!,
        {
          agentKey: "local:agents/research",
          identityStatus: "provisional",
          identityIssue: "identity-unavailable",
          path: "agents/research",
          entrypoint: "index.ts",
        },
      ],
    });
    const result = staticResult(
      [
        invocation(
          "coordinator",
          "local:agents/research",
          "blocking",
          "callsite:provisional-research",
        ),
      ],
      { inventory },
    );

    expect(result.outcome).toBe("success");
    expect(result.coverage.status).toBe("complete");
    expect(result.evidence[0]).toMatchObject({
      fromAgentKey: "coordinator",
      toAgentKey: "local:agents/research",
    });
    expect(
      projectPackageGraphEvidence(inventory, [result]).inventoryStatus,
    ).toBe("degraded");
  });

  it("drops stale endpoints with diagnostics when identity changes at the same inventory version", () => {
    const canonicalInventory = workingInventory();
    const result = staticResult([invocation("coordinator", "research")], {
      inventory: canonicalInventory,
    });
    const degradedInventory = workingInventory({
      status: "degraded",
      agents: [
        canonicalInventory.agents[0]!,
        canonicalInventory.agents[1]!,
        {
          agentKey: "local:agents/research",
          identityStatus: "provisional",
          identityIssue: "identity-unavailable",
          path: "agents/research",
          entrypoint: "index.ts",
        },
      ],
    });

    const projection = projectPackageGraphEvidence(degradedInventory, [result]);

    expect(projection.connectors).toEqual([]);
    expect(projection.nodes.map(({ agentKey }) => agentKey)).toEqual([
      "coordinator",
      "growth",
      "local:agents/research",
    ]);
    expect(projection.diagnostics).toContainEqual({
      code: "unknown-endpoint",
      severity: "error",
      evidenceId: result.evidence[0]!.evidenceId,
      endpoint: "to",
    });
  });

  it("quarantines unknown, invalid, ambiguous, self, and cross-scope candidates", () => {
    const ambiguousInventory = workingInventory({
      status: "degraded",
      agents: [
        workingInventory().agents[0]!,
        {
          agentKey: "local:research-a",
          identityStatus: "provisional",
          identityIssue: "duplicate-agent-key",
          candidateAgentKey: "research",
          path: "research-a",
          entrypoint: "index.ts",
        },
        {
          agentKey: "local:research-b",
          identityStatus: "provisional",
          identityIssue: "duplicate-agent-key",
          candidateAgentKey: "research",
          path: "research-b",
          entrypoint: "index.ts",
        },
      ],
    });
    const rejected = staticResult(
      [
        invocation("coordinator", "missing"),
        invocation(
          "coordinator",
          "/private/agent",
          "blocking",
          "callsite:invalid-target",
        ),
        invocation("coordinator", "research"),
        invocation("coordinator", "coordinator"),
      ],
      { inventory: ambiguousInventory },
    );

    expect(rejected.evidence).toEqual([]);
    expect(rejected.quarantine.map(({ code }) => code)).toEqual([
      "ambiguous-endpoint",
      "illegal-self-relationship",
      "invalid-endpoint",
      "unknown-endpoint",
    ]);
    expect(rejected.quarantine.every((item) => !("agentKey" in item))).toBe(
      true,
    );
    const rejectedProjection = projectPackageGraphEvidence(
      ambiguousInventory,
      [rejected],
    );
    expect(rejectedProjection.diagnostics.length).toBeGreaterThan(0);
    expect(
      rejectedProjection.diagnostics.every(
        (diagnostic) => !("quarantineId" in diagnostic),
      ),
    ).toBe(true);

    const otherScope = staticResult([invocation("coordinator", "research")], {
      scope: {
        kind: "working-tree",
        workspaceKey: "workspace-other",
        revision: SHA_A,
      },
    });
    expect(otherScope.evidence).toEqual([]);
    expect(otherScope.quarantine.map(({ code }) => code)).toEqual([
      "cross-scope",
    ]);
    const crossScopeProjection = projectPackageGraphEvidence(bundleInventory(), [
      staticResult([invocation("coordinator", "research")]),
    ]);
    expect(crossScopeProjection.connectors).toEqual([]);
    expect(crossScopeProjection.diagnostics).toContainEqual({
      code: "cross-scope",
      severity: "error",
    });
  });

  it("rejects old bundles and local/bundle mixing without mutating identities", () => {
    const inventory = bundleInventory();
    const canonical = staticResult([invocation("coordinator", "research")], {
      inventory,
    });
    expect(canonical).toMatchObject({
      scope: inventory.version,
      outcome: "success",
      coverage: { status: "complete" },
    });
    expect(canonical.evidence).toHaveLength(1);

    const stale = staticResult([invocation("coordinator", "research")], {
      inventory,
      scope: { kind: "bundle", bundleDigest: SHA_C },
    });
    expect(stale.evidence).toEqual([]);
    expect(stale.quarantine[0]?.code).toBe("cross-scope");

    expect(() =>
      createPackageGraphRuntimeEvidenceEvent(
        {
          eventId: "dispatch:1",
          scope: workingInventory().version as never,
          producer: PRODUCER,
          candidate: {
            fromAgentKey: "coordinator",
            toAgentKey: "research",
            relation: "invokes",
            basis: "runtime-dispatch",
            callerExecution: execution("execution:caller"),
            calleeExecution: execution("execution:callee"),
          },
        },
        workingInventory(),
      ),
    ).toThrow(/bundle scope/);
  });

  it("deduplicates identical records without dropping distinct callsite provenance", () => {
    const duplicate = invocation("coordinator", "research");
    const result = staticResult([
      duplicate,
      duplicate,
      invocation(
        "coordinator",
        "research",
        "blocking",
        "callsite:coordinator.research.second",
      ),
    ]);

    expect(result.evidence).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "duplicate-evidence",
        severity: "warning",
      }),
    );
  });

  it("rejects tampered IDs, unknown fields, raw payloads, and unsafe references", () => {
    const result = staticResult([invocation("coordinator", "research")]);
    expect(() =>
      packageGraphEvidenceStaticResultSchema.parse({
        ...result,
        resultId: SHA_B,
      }),
    ).toThrow(/Result ID/);
    expect(() =>
      packageGraphEvidenceStaticResultSchema.parse({
        ...result,
        evidence: [{ ...result.evidence[0]!, evidenceId: SHA_B }],
      }),
    ).toThrow(/Evidence ID/);
    expect(() =>
      packageGraphEvidenceCandidateSchema.parse({
        ...invocation("coordinator", "research"),
        prompt: "raw customer content",
      }),
    ).toThrow();
    expect(() =>
      packageGraphEvidenceCandidateSchema.parse({
        ...invocation("coordinator", "research"),
        callsites: [
          {
            kind: "source-callsite",
            ref: "agents/research/index.ts:1",
            file: "/private/agents/research/index.ts",
            line: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("keeps static replacement, partial, and failure semantics explicit", () => {
    const complete = staticResult([invocation("coordinator", "research")]);
    const initial = advancePackageGraphStaticEvidenceState(undefined, complete);
    expect(initial.status).toBe("ready");

    const retracted = staticResult([]);
    const replaced = advancePackageGraphStaticEvidenceState(initial, retracted);
    expect(replaced.status).toBe("ready");
    if (replaced.status === "failed") throw new Error("complete result failed");
    expect(replaced.accepted.evidence).toEqual([]);

    const partial = staticResult([invocation("coordinator", "growth")], {
      coverage: {
        status: "partial",
        gaps: [{ code: "work-cap" }, { code: "opaque-boundary" }],
      },
      diagnostics: [{ code: "incomplete-analysis", severity: "warning" }],
    });
    const stale = advancePackageGraphStaticEvidenceState(initial, partial);
    expect(stale).toMatchObject({
      status: "stale",
      accepted: { resultId: complete.resultId },
      latestAttempt: { resultId: partial.resultId },
    });

    const failed = staticResult([], {
      outcome: "failure",
      coverage: { status: "none", gaps: [{ code: "producer-failed" }] },
      diagnostics: [{ code: "producer-failed", severity: "error" }],
    });
    expect(advancePackageGraphStaticEvidenceState(stale, failed)).toMatchObject(
      {
        status: "stale",
        accepted: { resultId: complete.resultId },
        latestAttempt: { resultId: failed.resultId },
      },
    );
    expect(
      advancePackageGraphStaticEvidenceState(undefined, partial).status,
    ).toBe("partial");
    expect(
      advancePackageGraphStaticEvidenceState(undefined, failed).status,
    ).toBe("failed");
  });

  it("requires explicit diagnostics for partial and failed producer outcomes", () => {
    expect(() =>
      staticResult([], {
        coverage: { status: "partial", gaps: [{ code: "work-cap" }] },
      }),
    ).toThrow(/incomplete-analysis/);
    expect(() =>
      staticResult([], {
        outcome: "failure",
        coverage: { status: "none", gaps: [{ code: "producer-failed" }] },
      }),
    ).toThrow(/producer-failed diagnostic/);
    expect(() =>
      staticResult([], {
        diagnostics: [
          {
            code: "dynamic-target",
            severity: "warning",
            reference: { kind: "source-callsite", ref: "callsite:dynamic" },
          },
        ],
      }),
    ).toThrow(/cannot claim complete coverage/);
  });

  it("deduplicates runtime retries by authoritative event ID and quarantines conflicts", () => {
    const dispatch = acceptedRuntime("dispatch:stable", {
      fromAgentKey: "coordinator",
      toAgentKey: "research",
      relation: "invokes",
      basis: "runtime-dispatch",
      callerExecution: execution("execution:coordinator"),
      calleeExecution: execution("execution:research"),
    });
    const empty = { events: [], diagnostics: [] };
    const accepted = appendPackageGraphRuntimeEvidenceEvent(empty, dispatch);
    const duplicate = appendPackageGraphRuntimeEvidenceEvent(
      accepted.state,
      dispatch,
    );
    expect(accepted.status).toBe("accepted");
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.state.events).toHaveLength(1);

    const conflicting = acceptedRuntime("dispatch:stable", {
      fromAgentKey: "coordinator",
      toAgentKey: "growth",
      relation: "invokes",
      basis: "runtime-dispatch",
      callerExecution: execution("execution:coordinator"),
      calleeExecution: execution("execution:growth"),
    });
    const conflict = appendPackageGraphRuntimeEvidenceEvent(
      duplicate.state,
      conflicting,
    );
    expect(conflict.status).toBe("conflict");
    expect(conflict.state.events).toEqual([dispatch]);
    expect(conflict.state.diagnostics).toEqual([
      {
        code: "runtime-event-conflict",
        severity: "error",
        eventId: "dispatch:stable",
      },
    ]);
  });

  it("rejects runtime events from a different bundle before they enter state", () => {
    const first = acceptedRuntime("dispatch:first", {
      fromAgentKey: "coordinator",
      toAgentKey: "research",
      relation: "invokes",
      basis: "runtime-dispatch",
      callerExecution: execution("execution:coordinator"),
      calleeExecution: execution("execution:research"),
    });
    const otherBundle = acceptedRuntime(
      "dispatch:other-bundle",
      {
        fromAgentKey: "coordinator",
        toAgentKey: "research",
        relation: "invokes",
        basis: "runtime-dispatch",
        callerExecution: execution("execution:coordinator-other"),
        calleeExecution: execution("execution:research-other"),
      },
      SHA_C,
    );
    const accepted = appendPackageGraphRuntimeEvidenceEvent(
      { events: [], diagnostics: [] },
      first,
    );

    const conflict = appendPackageGraphRuntimeEvidenceEvent(
      accepted.state,
      otherBundle,
    );

    expect(conflict.status).toBe("conflict");
    expect(conflict.state.events).toEqual([first]);
    expect(conflict.state.diagnostics).toContainEqual({
      code: "cross-scope",
      severity: "error",
      eventId: "dispatch:other-bundle",
    });
  });

  it("keeps runtime and static envelopes distinct and runtime mode-free", () => {
    const runtime = acceptedRuntime("handoff:stable", {
      fromAgentKey: "research",
      toAgentKey: "growth",
      relation: "feeds",
      basis: "runtime-handoff",
      producerExecution: execution("execution:research"),
      consumerExecution: execution("execution:growth"),
      lineage: { kind: "lineage", ref: "lineage:report" },
    });
    const staticEvidence = staticResult([dataflow("research", "growth")]);

    expect(packageGraphRuntimeEvidenceEventSchema.parse(runtime).kind).toBe(
      "runtime-event",
    );
    expect(() =>
      packageGraphRuntimeEvidenceEventSchema.parse(staticEvidence),
    ).toThrow();
    expect(() =>
      packageGraphEvidenceStaticResultSchema.parse(runtime),
    ).toThrow();
    expect(runtime.evidence).not.toHaveProperty("mode");
  });

  it("projects multiple bases onto stable connectors while preserving all inventory nodes", () => {
    const inventory = bundleInventory();
    const staticEvidence = staticResult(
      [invocation("coordinator", "research"), dataflow("research", "growth")],
      { inventory },
    );
    const runtimeDispatch = acceptedRuntime("dispatch:projection", {
      fromAgentKey: "coordinator",
      toAgentKey: "research",
      relation: "invokes",
      basis: "runtime-dispatch",
      callerExecution: execution("execution:coordinator"),
      calleeExecution: execution("execution:research"),
    });
    const projection = projectPackageGraphEvidence(inventory, [
      runtimeDispatch,
      staticEvidence,
    ]);

    expect(projection.nodes.map(({ agentKey }) => agentKey)).toEqual([
      "coordinator",
      "growth",
      "research",
    ]);
    expect(projection.connectors[0]).toMatchObject({
      fromAgentKey: "coordinator",
      toAgentKey: "research",
      relation: "invokes",
      bases: ["static-invocation", "runtime-dispatch"],
    });
    expect(projection.connectors[0]?.support).toHaveLength(2);
  });

  it("rejects non-JSON canonical inputs instead of silently changing identity", () => {
    expect(() =>
      canonicalPackageGraphEvidenceJson({ value: undefined }),
    ).toThrow(/undefined/);
    expect(() => canonicalPackageGraphEvidenceJson(Number.NaN)).toThrow(
      /finite/,
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalPackageGraphEvidenceJson(cyclic)).toThrow(/cyclic/);
  });

  it("exports the protocol and top-level envelope type surface", () => {
    expect(PACKAGE_GRAPH_EVIDENCE_PROTOCOL).toBe(1);
    const result: PackageGraphEvidenceStaticResult = staticResult([
      invocation("coordinator", "research"),
    ]);
    expect(result.evidence[0]).toMatchObject({
      fromAgentKey: "coordinator",
      toAgentKey: "research",
      relation: "invokes",
      basis: "static-invocation",
    });
  });
});
