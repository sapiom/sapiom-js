import { describe, expect, it } from "vitest";

import type { PackageInventory, PackageInventoryAgent } from "@sapiom/agent";

import type { SourceEvidence } from "./canvas-interconnections.js";
import type { AgentInventoryItem } from "./system-graph-inventory.js";
import {
  adaptDirectInvocationsToGraphEvidence,
  DIRECT_INVOCATION_EVIDENCE_PRODUCER,
  type DirectInvocationScan,
} from "./system-graph-invocation-evidence.js";
import type {
  AgentInvocationCandidate,
  AgentInvocationProviderResult,
} from "./system-graph-relationships.js";

const REVISION = `sha256:${"a".repeat(64)}` as const;
const SOURCE_A = `sha256:${"b".repeat(64)}` as const;
const SOURCE_B = `sha256:${"c".repeat(64)}` as const;
const SOURCE_C = `sha256:${"d".repeat(64)}` as const;

interface AgentFixture {
  context: AgentInventoryItem;
  public: PackageInventoryAgent;
}

function canonicalAgent(
  agentKey: string,
  aliases: readonly string[] = [],
): AgentFixture {
  return {
    context: {
      agentKey,
      identityStatus: "canonical",
      definitionId: null,
      definitionSlug: null,
      label: agentKey[0]!.toUpperCase() + agentKey.slice(1),
      resolutionAliases: [...aliases],
      sourceRoot: `/private/workspace/${agentKey}`,
      workflowPath: `/private/workspace/${agentKey}`,
      path: `agents/${agentKey}`,
      entrypoint: "index.ts",
    },
    public: {
      agentKey,
      identityStatus: "canonical",
      path: `agents/${agentKey}`,
      entrypoint: "index.ts",
    },
  };
}

function provisionalAgent(
  agentKey: string,
  aliases: readonly string[],
): AgentFixture {
  const safePath = agentKey.replace(/[:/]/g, "-");
  return {
    context: {
      agentKey,
      identityStatus: "provisional",
      definitionId: null,
      definitionSlug: null,
      label: safePath,
      resolutionAliases: [...aliases],
      sourceRoot: `/private/workspace/${safePath}`,
      workflowPath: `/private/workspace/${safePath}`,
      path: `agents/${safePath}`,
      entrypoint: "index.ts",
    },
    public: {
      agentKey,
      identityStatus: "provisional",
      identityIssue: "identity-unavailable",
      path: `agents/${safePath}`,
      entrypoint: "index.ts",
    },
  };
}

function inventory(fixtures: readonly AgentFixture[]): PackageInventory {
  return {
    protocol: 1,
    version: {
      kind: "working-tree",
      workspaceKey: "workspace-adapter",
      revision: REVISION,
    },
    status: fixtures.some(
      (fixture) => fixture.public.identityStatus === "provisional",
    )
      ? "degraded"
      : "complete",
    agents: fixtures.map((fixture) => fixture.public),
  };
}

function source(file: string, line: number, column = 1): SourceEvidence {
  return { file, line, column };
}

function result(
  invocations: readonly AgentInvocationCandidate[] = [],
  overrides: Partial<AgentInvocationProviderResult> = {},
): AgentInvocationProviderResult {
  return {
    invocations: [...invocations],
    warnings: [],
    complete: true,
    sourceFingerprint: SOURCE_A,
    ...overrides,
  };
}

function scan(
  fixture: AgentFixture,
  providerResult = result(),
  flags: Pick<DirectInvocationScan, "failed" | "pending"> = {
    failed: false,
    pending: false,
  },
): DirectInvocationScan {
  return { caller: fixture.context, result: providerResult, ...flags };
}

function contexts(fixtures: readonly AgentFixture[]): AgentInventoryItem[] {
  return fixtures.map((fixture) => fixture.context);
}

describe("adaptDirectInvocationsToGraphEvidence", () => {
  it("maps only resolved direct calls to explicit-endpoint evidence and the unchanged public edge DTO", () => {
    const coordinator = canonicalAgent("coordinator", ["coordinator"]);
    const research = canonicalAgent("research", ["research"]);
    const growth = canonicalAgent("growth", ["growth"]);
    const fixtures = [coordinator, research, growth];
    const packageInventory = inventory(fixtures);

    const adapted = adaptDirectInvocationsToGraphEvidence({
      inventory: packageInventory,
      agents: contexts(fixtures),
      scans: [
        scan(
          coordinator,
          result([
            {
              target: "research",
              mode: "blocking",
              evidence: [source("src/private/coordinator.ts", 4, 3)],
            },
            {
              target: "growth",
              mode: "async",
              evidence: [source("src/private/coordinator.ts", 9, 5)],
            },
          ]),
        ),
        scan(research),
        scan(growth),
      ],
    });

    expect(adapted.complete).toBe(true);
    expect(adapted.latestResult).toMatchObject({
      protocol: 1,
      kind: "static-result",
      scope: packageInventory.version,
      producer: DIRECT_INVOCATION_EVIDENCE_PRODUCER,
      outcome: "success",
    });
    expect(adapted.latestResult.analysisFingerprint).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(adapted.latestResult.coverage).toEqual({ status: "complete" });
    expect(
      adapted.latestResult.evidence.map((evidence) => ({
        fromAgentKey: evidence.fromAgentKey,
        toAgentKey: evidence.toAgentKey,
        relation: evidence.relation,
        basis: evidence.basis,
        mode: evidence.basis === "static-invocation" ? evidence.mode : null,
      })),
    ).toEqual([
      {
        fromAgentKey: "coordinator",
        toAgentKey: "growth",
        relation: "invokes",
        basis: "static-invocation",
        mode: "async",
      },
      {
        fromAgentKey: "coordinator",
        toAgentKey: "research",
        relation: "invokes",
        basis: "static-invocation",
        mode: "blocking",
      },
    ]);
    expect(adapted.edges).toEqual([
      {
        from: "agent:coordinator",
        to: "agent:growth",
        kind: "invokes",
        basis: "static-invocation",
        mode: "async",
      },
      {
        from: "agent:coordinator",
        to: "agent:research",
        kind: "invokes",
        basis: "static-invocation",
        mode: "blocking",
      },
    ]);
    expect(adapted.edges).not.toContainEqual(
      expect.objectContaining({
        from: "agent:research",
        to: "agent:growth",
      }),
    );
    expect(
      adapted.latestResult.evidence.flatMap((evidence) =>
        evidence.basis === "static-invocation" ? evidence.callsites : [],
      ),
    ).toEqual([
      {
        kind: "source-callsite",
        ref: expect.stringMatching(/^callsite:sha256:[0-9a-f]{64}$/),
      },
      {
        kind: "source-callsite",
        ref: expect.stringMatching(/^callsite:sha256:[0-9a-f]{64}$/),
      },
    ]);
    expect(JSON.stringify(adapted)).not.toContain("src/private");
    expect(JSON.stringify(adapted)).not.toContain("/private/workspace");
  });

  it("is deterministic, ignores watcher metadata, and changes identity for source-content freshness", () => {
    const caller = canonicalAgent("caller");
    const target = canonicalAgent("target");
    const fixtures = [caller, target];
    const firstEvidence = source("src/caller.ts", 8, 2);
    const secondEvidence = source("src/caller.ts", 3, 7);
    const invocation = (
      evidence: SourceEvidence[],
    ): AgentInvocationCandidate => ({
      target: "target",
      mode: "blocking",
      evidence,
    });

    const first = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(
          caller,
          result([invocation([firstEvidence, secondEvidence])], {
            observedPaths: ["/private/first"],
          }),
        ),
        scan(target),
      ],
    });
    const reordered = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(target, result([], { observedPaths: ["/private/other"] })),
        scan(
          caller,
          result([invocation([secondEvidence, firstEvidence])], {
            observedPaths: ["/private/reordered"],
          }),
        ),
      ],
    });

    expect(reordered.latestResult).toEqual(first.latestResult);
    expect(reordered.edges).toEqual(first.edges);

    const edited = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(
          caller,
          result([invocation([firstEvidence, secondEvidence])], {
            sourceFingerprint: SOURCE_B,
          }),
        ),
        scan(target),
      ],
    });

    expect(edited.latestResult.analysisFingerprint).not.toBe(
      first.latestResult.analysisFingerprint,
    );
    expect(edited.latestResult.resultId).not.toBe(first.latestResult.resultId);
    expect(edited.latestResult.evidence[0]?.evidenceId).not.toBe(
      first.latestResult.evidence[0]?.evidenceId,
    );
    expect(edited.edges).toEqual(first.edges);
  });

  it("keeps last-good evidence for pending or failed refreshes and retracts it after a complete refresh", () => {
    const caller = canonicalAgent("caller");
    const target = canonicalAgent("target");
    const fixtures = [caller, target];
    const directCall = {
      target: "target",
      mode: "async" as const,
      evidence: [source("src/caller.ts", 2)],
    };
    const initial = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [scan(caller, result([directCall])), scan(target)],
    });

    const pending = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(caller, result(), { failed: false, pending: true }),
        scan(target),
      ],
      previousState: initial.state,
    });
    expect(pending.complete).toBe(false);
    expect(pending.state.status).toBe("stale");
    expect(pending.edges).toEqual(initial.edges);
    expect(pending.latestResult.coverage.status).toBe("partial");

    const failed = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: fixtures.map((fixture) =>
        scan(fixture, result(), { failed: true, pending: false }),
      ),
      previousState: pending.state,
    });
    expect(failed.complete).toBe(false);
    expect(failed.state.status).toBe("stale");
    expect(failed.latestResult.outcome).toBe("failure");
    expect(failed.latestResult.coverage.status).toBe("none");
    expect(failed.edges).toEqual(initial.edges);

    const removed = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: fixtures.map((fixture) =>
        scan(fixture, result([], { sourceFingerprint: SOURCE_B })),
      ),
      previousState: failed.state,
    });
    expect(removed.complete).toBe(true);
    expect(removed.state.status).toBe("ready");
    expect(removed.edges).toEqual([]);
    expect(removed.latestResult.evidence).toEqual([]);
  });

  it("refreshes the proven literal subset across consecutive settled partial scans", () => {
    const caller = canonicalAgent("caller");
    const target = canonicalAgent("target");
    const fixtures = [caller, target];
    const directCall = {
      target: "target",
      mode: "async" as const,
      evidence: [source("src/caller.ts", 2)],
    };
    const first = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(caller, result([directCall], { complete: false })),
        scan(target),
      ],
    });

    expect(first.complete).toBe(false);
    expect(first.cacheable).toBe(false);
    expect(first.state.status).toBe("partial");
    expect(first.edges).toHaveLength(1);

    const removed = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(
          caller,
          result([], { complete: false, sourceFingerprint: SOURCE_B }),
        ),
        scan(target),
      ],
      previousState: first.state,
    });
    expect(removed.state.status).toBe("partial");
    expect(removed.edges).toEqual([]);

    const added = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(
          caller,
          result([directCall], {
            complete: false,
            sourceFingerprint: SOURCE_C,
          }),
        ),
        scan(target),
      ],
      previousState: removed.state,
    });
    expect(added.state.status).toBe("partial");
    expect(added.edges).toEqual(first.edges);
  });

  it("never upgrades missing, pending, incomplete, or freshness-less caller scans to complete", () => {
    const caller = canonicalAgent("caller");
    const target = canonicalAgent("target");
    const fixtures = [caller, target];
    const attempts = [
      [scan(caller)],
      [scan(caller), scan(target, result(), { failed: false, pending: true })],
      [scan(caller), scan(target, result([], { complete: false }))],
      [
        scan(caller),
        scan(target, result([], { sourceFingerprint: undefined })),
      ],
    ];

    for (const scans of attempts) {
      const adapted = adaptDirectInvocationsToGraphEvidence({
        inventory: inventory(fixtures),
        agents: contexts(fixtures),
        scans,
      });
      expect(adapted.complete).toBe(false);
      expect(adapted.latestResult.outcome).toBe("success");
      expect(adapted.latestResult.coverage.status).toBe("partial");
      expect(
        adapted.latestResult.diagnostics.some(
          (diagnostic) => diagnostic.code === "incomplete-analysis",
        ),
      ).toBe(true);
    }

    const failed = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: fixtures.map((fixture) =>
        scan(fixture, result(), { failed: true, pending: false }),
      ),
    });
    expect(failed.complete).toBe(false);
    expect(failed.latestResult.outcome).toBe("failure");
    expect(failed.latestResult.coverage.status).toBe("none");
    expect(failed.state.status).toBe("failed");
  });

  it("uses shared diagnostics and quarantine while keeping unsafe targets out of public output", () => {
    const caller = canonicalAgent("caller");
    const target = canonicalAgent("target");
    const fixtures = [caller, target];
    const adapted = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(
          caller,
          result([
            {
              target: "target",
              mode: "blocking",
              evidence: [
                source("src/caller.ts", 1),
                source("src/caller.ts", 2),
              ],
            },
            {
              target: "caller",
              mode: "async",
              evidence: [source("src/caller.ts", 3)],
            },
            {
              target: "missing",
              mode: "async",
              evidence: [source("src/caller.ts", 4)],
            },
            {
              target: "/private/secret-agent",
              mode: "blocking",
              evidence: [source("src/caller.ts", 5)],
            },
          ]),
        ),
        scan(target),
      ],
    });

    expect(adapted.edges).toEqual([
      {
        from: "agent:caller",
        to: "agent:target",
        kind: "invokes",
        basis: "static-invocation",
        mode: "blocking",
      },
    ]);
    expect(
      new Set(adapted.latestResult.diagnostics.map(({ code }) => code)),
    ).toEqual(
      new Set([
        "duplicate-evidence",
        "illegal-self-relationship",
        "invalid-endpoint",
        "unknown-endpoint",
      ]),
    );
    expect(
      new Set(adapted.latestResult.quarantine.map(({ code }) => code)),
    ).toEqual(
      new Set([
        "illegal-self-relationship",
        "invalid-endpoint",
        "unknown-endpoint",
      ]),
    );
    expect(adapted.warnings.map(({ code }) => code)).toEqual([
      "duplicate-edge",
      "unresolved-target",
      "unresolved-target",
    ]);
    expect(JSON.stringify(adapted)).not.toContain("/private/secret-agent");
    expect(adapted.warnings).toContainEqual({
      code: "unresolved-target",
      agentKey: "caller",
      message: "Caller invokes an invalid agent target.",
    });
  });

  it("resolves one provisional alias but diagnoses an ambiguous alias without inventing an edge", () => {
    const caller = canonicalAgent("caller");
    const first = provisionalAgent("local:first", ["legacy"]);
    const oneMatch = [caller, first];
    const resolved = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(oneMatch),
      agents: contexts(oneMatch),
      scans: [
        scan(
          caller,
          result([
            {
              target: "legacy",
              mode: "async",
              evidence: [source("src/caller.ts", 1)],
            },
          ]),
        ),
        scan(first),
      ],
    });
    expect(resolved.edges).toEqual([
      {
        from: "agent:caller",
        to: "agent:local:first",
        kind: "invokes",
        basis: "static-invocation",
        mode: "async",
      },
    ]);

    const second = provisionalAgent("local:second", ["legacy"]);
    const ambiguousFixtures = [caller, first, second];
    const ambiguous = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(ambiguousFixtures),
      agents: contexts(ambiguousFixtures),
      scans: [
        scan(
          caller,
          result([
            {
              target: "legacy",
              mode: "async",
              evidence: [source("src/caller.ts", 1)],
            },
          ]),
        ),
        scan(first),
        scan(second),
      ],
    });
    expect(ambiguous.edges).toEqual([]);
    expect(ambiguous.latestResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ambiguous-endpoint", endpoint: "to" }),
    );
    expect(ambiguous.warnings).toContainEqual({
      code: "unresolved-target",
      agentKey: "caller",
      message: "Caller invokes ambiguous agent legacy.",
    });
  });

  it("marks dynamic callsites partial and exposes only an opaque diagnostic reference", () => {
    const caller = canonicalAgent("caller");
    const fixtures = [caller];
    const adapted = adaptDirectInvocationsToGraphEvidence({
      inventory: inventory(fixtures),
      agents: contexts(fixtures),
      scans: [
        scan(
          caller,
          result([], {
            warnings: [
              {
                code: "dynamic-target",
                mode: "blocking",
                evidence: source("src/private/dynamic.ts", 12, 4),
              },
            ],
          }),
        ),
      ],
    });

    expect(adapted.complete).toBe(false);
    expect(adapted.cacheable).toBe(true);
    expect(adapted.latestResult.coverage.status).toBe("partial");
    expect(adapted.latestResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "dynamic-target",
        reference: {
          kind: "source-callsite",
          ref: expect.stringMatching(/^callsite:sha256:[0-9a-f]{64}$/),
        },
      }),
    );
    expect(adapted.warnings).toEqual([
      {
        code: "dynamic-target",
        agentKey: "caller",
        message: "Caller has a dynamic agent target that V0 cannot resolve.",
      },
    ]);
    expect(JSON.stringify(adapted)).not.toContain("src/private/dynamic.ts");
  });
});
