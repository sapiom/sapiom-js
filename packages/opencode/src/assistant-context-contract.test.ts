import { describe, expect, it } from "vitest";
import {
  AssistantContextError,
  assistantContentHash,
  assistantDescriptorHash,
  assistantRevision,
  encodeAssistantContext,
  validateAcceptedAssistantContext,
  validateSourceVersion,
  validateInstructionSet,
  validateAssistantFacts,
} from "./assistant-context-contract.js";
import {
  fixtureAccepted,
  fixtureScope,
  fixtureSource,
} from "./__fixtures__/assistant-context.js";

describe("accepted context contract", () => {
  it("validates a detached accepted record with complete empty manifests", () => {
    const accepted = fixtureAccepted();
    const saved = JSON.parse(encodeAssistantContext(accepted));
    expect(() => validateAcceptedAssistantContext(saved)).not.toThrow();
    expect(saved).toEqual(accepted);
  });
  it("hashes exact bytes and canonical descriptors with provenance", () => {
    expect(assistantContentHash("x\r\n")).not.toBe(assistantContentHash("x\n"));
    expect(assistantContentHash(Buffer.from("x\r\n"))).toBe(
      assistantContentHash("x\r\n"),
    );
    expect(assistantDescriptorHash({ b: 2, a: 1 })).toBe(
      assistantDescriptorHash({ a: 1, b: 2 }),
    );
    const source = fixtureSource("profile", "profile", "exact");
    expect(
      assistantRevision({ ...source, source: "another provider" }),
    ).not.toBe(source.revision);
  });
  it("validates explicit unavailable and fallback sources", () => {
    const unavailable = {
      id: "rules",
      kind: "project",
      authorityScope: fixtureScope,
      source: "host",
      required: false,
      status: "not-configured",
      contentHash: null,
      reason: "Provider not configured",
      revision: "",
    };
    unavailable.revision = assistantRevision(unavailable);
    expect(() =>
      validateSourceVersion(unavailable, fixtureScope),
    ).not.toThrow();
    expect(() =>
      validateSourceVersion({ ...unavailable, required: true }, fixtureScope),
    ).toThrow(AssistantContextError);
    expect(() =>
      validateSourceVersion(
        { ...unavailable, contentRef: "live/path" },
        fixtureScope,
      ),
    ).toThrow(AssistantContextError);
    const fallback = {
      ...fixtureSource("profile", "profile", "bundled"),
      fallback: { fromSource: "remote", reason: "offline" },
    };
    fallback.revision = assistantRevision(fallback);
    expect(() => validateSourceVersion(fallback, fixtureScope)).not.toThrow();
  });
  it.each([
    [
      "acceptance ID",
      (value: any) => {
        value.acceptanceId = "../other";
      },
    ],
    [
      "scope",
      (value: any) => {
        value.authorityScope = "b".repeat(64);
      },
    ],
    [
      "conversation",
      (value: any) => {
        value.conversationId = "../session";
      },
    ],
    [
      "facts",
      (value: any) => {
        value.context.environment = "changed";
      },
    ],
    [
      "source provenance",
      (value: any) => {
        value.instructionSet.sources[0].source = "changed";
      },
    ],
    [
      "unknown field",
      (value: any) => {
        value.credential = "never accepted";
      },
    ],
    [
      "schema",
      (value: any) => {
        value.schemaVersion = 2;
      },
    ],
    [
      "hash",
      (value: any) => {
        value.revision = "a".repeat(64);
      },
    ],
  ])("rejects changed %s without exposing values", (_name, change) => {
    const value = structuredClone(fixtureAccepted());
    change(value);
    expect(() => validateAcceptedAssistantContext(value)).toThrow(
      "Studio assistant context unavailable",
    );
  });
  it("requires retained manifests, unique source IDs, and actual profile/policy", () => {
    const original = fixtureAccepted().instructionSet;
    for (const sources of [
      original.sources.slice(1),
      [...original.sources, original.sources[0]!],
      original.sources.filter(
        (source) => source.status !== "available" || source.format !== "json",
      ),
    ]) {
      const value = { ...original, sources };
      value.revision = assistantRevision(value);
      expect(() => validateInstructionSet(value, fixtureScope)).toThrow(
        AssistantContextError,
      );
    }
  });
  it("validates agent selections against the recorded inventory", () => {
    const facts = fixtureAccepted().context;
    const agent = {
      name: "chosen",
      path: "/workspace/chosen",
      definitionId: 1,
    };
    facts.selectedAgent = { status: "available", agent };
    expect(() => validateAssistantFacts(facts)).toThrow(AssistantContextError);
    facts.agents = [agent];
    expect(() => validateAssistantFacts(facts)).not.toThrow();
    facts.agents.push(agent);
    expect(() => validateAssistantFacts(facts)).toThrow(AssistantContextError);
  });
  it("rejects unknown shapes, duplicate tools, unsupported numbers and cycles", () => {
    const facts = fixtureAccepted().context;
    facts.capabilities = [
      { name: "mcp", status: "available", tools: ["read", "read"] },
    ];
    expect(() => validateAssistantFacts(facts)).toThrow(AssistantContextError);
    for (const value of [
      undefined,
      new Date(),
      NaN,
      Infinity,
      new Uint8Array(1),
    ]) {
      expect(() => encodeAssistantContext(value)).toThrow(
        AssistantContextError,
      );
    }
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => encodeAssistantContext(cyclic)).toThrow(AssistantContextError);
  });
  it("bounds entries, nesting and bytes without truncating instructions", () => {
    expect(() => encodeAssistantContext(Array(4097).fill(0))).toThrow(
      AssistantContextError,
    );
    expect(() => encodeAssistantContext("x".repeat(4 * 1024 * 1024))).toThrow(
      AssistantContextError,
    );
    expect(
      encodeAssistantContext("x".repeat(4 * 1024 * 1024 - 2)),
    ).toHaveLength(4 * 1024 * 1024);
  });
  it("rejects sparse arrays before hashing or accepting a record", () => {
    expect(() => encodeAssistantContext(Array(1))).toThrow(
      AssistantContextError,
    );
    const facts = fixtureAccepted().context;
    facts.capabilities = [
      { name: "tools", status: "available", tools: Array(1) },
    ];
    expect(() => validateAssistantFacts(facts)).toThrow(AssistantContextError);
  });
  it("bounds object entries as well as array entries", () => {
    const object = Object.fromEntries(
      Array.from({ length: 4097 }, (_, index) => [String(index), true]),
    );
    expect(() => encodeAssistantContext(object)).toThrow(AssistantContextError);
    delete object["4096"];
    expect(() => encodeAssistantContext(object)).not.toThrow();
  });
  it("rejects custom array iteration instead of hashing a different JSON value", () => {
    const tools = ["actual"];
    tools[Symbol.iterator] = () => ["substituted"].values();
    expect(() => encodeAssistantContext(tools)).toThrow(AssistantContextError);
    const facts = fixtureAccepted().context;
    facts.capabilities = [{ name: "mcp", status: "available", tools }];
    expect(() => validateAssistantFacts(facts)).toThrow(AssistantContextError);
  });
  it("rejects aggregate catalog size before walking every capability semantically", () => {
    const accepted = fixtureAccepted();
    const tools = Array.from(
      { length: 4096 },
      (_, index) => `${index}${"x".repeat(128)}`,
    );
    let catalogsRead = 0;
    accepted.context.capabilities = Array.from({ length: 64 }, (_, index) => ({
      name: String(index),
      status: "available" as const,
      get tools() {
        catalogsRead++;
        return tools;
      },
    }));
    expect(() => validateAcceptedAssistantContext(accepted)).toThrow(
      AssistantContextError,
    );
    expect(catalogsRead).toBeLessThan(64);
  });
});
