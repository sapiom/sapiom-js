import {
  PACKAGE_AGENT_FACTS_PROTOCOL,
  PACKAGE_INVENTORY_PROTOCOL,
  canonicalPackageAgentFactsJson,
  createPackageAgentFactsSnapshot,
  packageAgentFactsSnapshotSchema,
  type PackageAgentFactsProducer,
  type PackageInventory,
} from "./index.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const EXTRACTOR: PackageAgentFactsProducer = {
  id: "sapiom.agent-card",
  version: "1.0.0",
};

function inventory(): PackageInventory {
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
        agentKey: "research",
        identityStatus: "canonical",
        path: "agents/research",
        entrypoint: "index.ts",
      },
      {
        agentKey: "coordinator",
        identityStatus: "canonical",
        path: "agents/coordinator",
        entrypoint: "index.ts",
      },
    ],
  };
}

function snapshot(cards: readonly unknown[], sourceInventory = inventory()) {
  return createPackageAgentFactsSnapshot(
    { scope: sourceInventory.version, extractor: EXTRACTOR, cards },
    sourceInventory,
  );
}

describe("package AgentFacts protocol 1", () => {
  it("normalizes complete authored facts under authoritative inventory agent keys", () => {
    const normalized = snapshot([
      {
        agentKey: "research",
        sourceReferences: [
          { kind: "source-card", ref: "card:research" },
          { kind: "source-card", ref: "card:research" },
        ],
        directReferences: [
          { kind: "manifest-field", ref: "manifest:research" },
        ],
        evidenceReferences: [
          { kind: "graph-evidence-record", ref: "edge:coordinator.research" },
        ],
        description: "Researches public filings.",
        inputSchema: {
          properties: { ticker: { type: "string" } },
          type: "object",
        },
        outputSchema: {
          type: "object",
          properties: { memo: { type: "string" } },
        },
        declaredCapabilities: ["web.scrape", "llm.run", "web.scrape"],
        observed: [
          {
            kind: "capability-call",
            capability: "database.query",
            reference: { kind: "agent-facts-evidence", ref: "obs:query" },
          },
        ],
      },
      {
        agentKey: "coordinator",
        description: null,
        inputSchema: null,
        outputSchema: null,
        declaredCapabilities: [],
        observed: [],
      },
    ]);

    expect(normalized.protocol).toBe(PACKAGE_AGENT_FACTS_PROTOCOL);
    expect(normalized.agents.map((agent) => agent.agentKey)).toEqual([
      "coordinator",
      "research",
    ]);
    expect(normalized.agents[1]).toMatchObject({
      agentKey: "research",
      description: { status: "known", value: "Researches public filings." },
      capabilities: {
        declared: { status: "known", values: ["llm.run", "web.scrape"] },
        observed: { status: "known", values: ["database.query"] },
      },
      completeness: { status: "complete" },
    });
    expect(normalized.agents[1]?.references.source).toEqual([
      { kind: "source-card", ref: "card:research" },
    ]);
    expect(normalized.agents[1]?.references.evidence).toEqual([
      { kind: "agent-facts-evidence", ref: "obs:query" },
      { kind: "graph-evidence-record", ref: "edge:coordinator.research" },
    ]);
    expect(normalized.agents[1]?.summary).toBe(
      "agentKey: research; authored description: Researches public filings.; input schema: known; output schema: known; declared capabilities: llm.run, web.scrape; observed capabilities: database.query",
    );
    expect(packageAgentFactsSnapshotSchema.parse(normalized)).toEqual(
      normalized,
    );
  });

  it("keeps partial and missing card extraction from invalidating agent nodes", () => {
    const normalized = snapshot([
      {
        agentKey: "research",
        description: "Reads source documents.",
        declaredCapabilities: ["web.scrape"],
        completeness: {
          status: "partial",
          diagnostics: [
            {
              code: "incomplete-extraction",
              severity: "warning",
              agentKey: "research",
            },
          ],
        },
      },
    ]);

    expect(normalized.agents.map((agent) => agent.agentKey)).toEqual([
      "coordinator",
      "research",
    ]);
    expect(normalized.agents[0]).toMatchObject({
      agentKey: "coordinator",
      description: { status: "unknown" },
      inputSchema: { status: "unknown" },
      outputSchema: { status: "unknown" },
      capabilities: {
        declared: { status: "unknown" },
        observed: { status: "unknown" },
      },
      completeness: {
        status: "unknown",
        diagnostics: [
          {
            code: "missing-card",
            severity: "warning",
            agentKey: "coordinator",
          },
        ],
      },
    });
    expect(normalized.agents[1]?.completeness.status).toBe("partial");
    expect(normalized.diagnostics).toContainEqual({
      code: "missing-card",
      severity: "warning",
      agentKey: "coordinator",
    });
  });

  it("emits byte-identical normalized output for equivalent unordered inputs", () => {
    const first = snapshot([
      {
        agentKey: "research",
        declaredCapabilities: ["z.capability", "a.capability"],
        inputSchema: { z: true, a: { b: 1 } },
        observed: [
          { kind: "capability-call", capability: "email.send" },
          { kind: "capability-call", capability: "database.query" },
        ],
      },
      { agentKey: "coordinator", observed: [] },
    ]);
    const second = snapshot([
      { agentKey: "coordinator", observed: [] },
      {
        agentKey: "research",
        inputSchema: { a: { b: 1 }, z: true },
        observed: [
          { kind: "capability-call", capability: "database.query" },
          { kind: "capability-call", capability: "email.send" },
        ],
        declaredCapabilities: ["a.capability", "z.capability"],
      },
    ]);

    expect(canonicalPackageAgentFactsJson(first)).toBe(
      canonicalPackageAgentFactsJson(second),
    );
    expect(first.snapshotId).toBe(second.snapshotId);
  });

  it("rejects or ignores unsupported observed facts without inventing capabilities", () => {
    const normalized = snapshot([
      {
        agentKey: "coordinator",
        observed: [
          { kind: "tool-result", capability: "llm.run" },
          { kind: "capability-call", capability: "" },
          { kind: "capability-call", capability: "email.send" },
        ],
      },
      { agentKey: "research" },
      { agentKey: "ghost", description: "Unknown inventory member." },
      { nope: true },
    ]);

    expect(normalized.agents[0]?.capabilities.observed).toEqual({
      status: "known",
      values: ["email.send"],
    });
    expect(normalized.diagnostics).toEqual([
      { code: "invalid-card", severity: "warning" },
      {
        code: "invalid-observation",
        severity: "warning",
        agentKey: "coordinator",
      },
      {
        code: "unsupported-observed-fact",
        severity: "warning",
        agentKey: "coordinator",
      },
      {
        code: "unknown-agent-key",
        severity: "warning",
        agentKey: "ghost",
      },
    ]);
  });

  it("does not infer semantic prose or relationships from inventory names", () => {
    const normalized = snapshot([{ agentKey: "coordinator" }]);

    expect(normalized.agents[0]?.summary).toBe(
      "agentKey: coordinator; authored description: unknown; input schema: unknown; output schema: unknown; declared capabilities: unknown; observed capabilities: unknown",
    );
    expect(normalized.agents[0]?.references.evidence).toEqual([]);
    expect(normalized.agents[1]?.summary).toBe(
      "agentKey: research; authored description: unknown; input schema: unknown; output schema: unknown; declared capabilities: unknown; observed capabilities: unknown",
    );
  });

  it("rejects tampered summaries and non-normalized capability sets", () => {
    const normalized = snapshot([
      { agentKey: "coordinator", declaredCapabilities: ["a", "b"] },
      { agentKey: "research" },
    ]);

    expect(() =>
      packageAgentFactsSnapshotSchema.parse({
        ...normalized,
        agents: [
          {
            ...normalized.agents[0]!,
            summary: "Research coordinator with inferred routing behavior.",
          },
          normalized.agents[1]!,
        ],
      }),
    ).toThrow(/Summary does not match/);
    expect(() =>
      packageAgentFactsSnapshotSchema.parse({
        ...normalized,
        agents: [
          {
            ...normalized.agents[0]!,
            capabilities: {
              ...normalized.agents[0]!.capabilities,
              declared: { status: "known", values: ["b", "a", "b"] },
            },
          },
          normalized.agents[1]!,
        ],
      }),
    ).toThrow(/Capabilities must be unique/);
  });

  it("requires the exact package inventory version instead of remapping identity", () => {
    expect(() =>
      createPackageAgentFactsSnapshot(
        {
          scope: {
            kind: "working-tree",
            workspaceKey: "workspace-acme",
            revision: SHA_B,
          },
          extractor: EXTRACTOR,
          cards: [],
        },
        inventory(),
      ),
    ).toThrow(/scope must match/);
  });
});
