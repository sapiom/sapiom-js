/**
 * Unit tests for the local `llm.run` stub's handling of `LlmRunSpec.output`.
 *
 * `output` forces a tool call on the real surface, so the stub has to answer in
 * that shape — otherwise `structuredOf` reads `undefined` under `run_local` for
 * code that gets a value in production, and every caller that (rightly) refuses
 * to invent a value fails locally for the wrong reason (SAP-2892).
 */
import { createStubClient } from "./index.js";
import { structuredOf, textOf } from "../llm/index.js";

const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "comment", "request_changes"],
    },
    summary: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0.25 },
    blocking: { type: "boolean" },
    reviewer: { type: ["string", "null"] },
    ignored: { type: "string" },
  },
  required: [
    "verdict",
    "summary",
    "notes",
    "confidence",
    "blocking",
    "reviewer",
  ],
  additionalProperties: false,
};

describe("stub llm.run — structured output", () => {
  it("answers a text-only spec with a text block, unchanged", async () => {
    const client = createStubClient();

    const res = await client.llm.run({
      request: { messages: [{ role: "user", content: "hi" }] },
    });

    expect(textOf(res)).toBe("(stub) llm reply");
    expect(structuredOf(res)).toBeUndefined();
  });

  it("answers an `output` spec with a tool_use block named after the tool", async () => {
    const client = createStubClient();

    const res = await client.llm.run({
      request: { messages: [{ role: "user", content: "review this" }] },
      output: { name: "emit_review", schema: REVIEW_SCHEMA },
    });

    expect((res as { stop_reason?: string }).stop_reason).toBe("tool_use");
    expect(structuredOf(res, "emit_review")).toBeDefined();
    // A name that wasn't declared still reads as absent — `structuredOf` never
    // guesses at a block it didn't match.
    expect(structuredOf(res, "some_other_tool")).toBeUndefined();
  });

  it("fills the schema's required properties, and only those", () => {
    return createStubClient()
      .llm.run({
        request: { messages: [] },
        output: { name: "emit_review", schema: REVIEW_SCHEMA },
      })
      .then((res) => {
        const value = structuredOf<Record<string, unknown>>(res, "emit_review");

        // The first enum member, not a made-up string.
        expect(value?.verdict).toBe("approve");
        expect(value?.summary).toBe("(stub) summary");
        // One element per array, so a caller that requires a non-empty list
        // can still trace its graph.
        expect(value?.notes).toEqual(["(stub) notes"]);
        // `minimum` is respected rather than defaulting under it.
        expect(value?.confidence).toBe(0.25);
        expect(value?.blocking).toBe(false);
        // A nullable field takes the non-null type.
        expect(value?.reviewer).toBe("(stub) reviewer");
        // Declared but not required — the stub stays minimal.
        expect(value).not.toHaveProperty("ignored");
      });
  });

  it("honors minItems and nested object items", async () => {
    const client = createStubClient();

    const res = await client.llm.run({
      request: { messages: [] },
      output: {
        name: "emit_clusters",
        schema: {
          type: "object",
          properties: {
            clusters: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                properties: {
                  fingerprint: { type: "string" },
                  count: { type: "integer", minimum: 1 },
                },
                required: ["fingerprint", "count"],
              },
            },
          },
          required: ["clusters"],
        },
      },
    });

    expect(structuredOf(res, "emit_clusters")).toEqual({
      clusters: [
        { fingerprint: "(stub) fingerprint", count: 1 },
        { fingerprint: "(stub) fingerprint", count: 1 },
      ],
    });
  });

  it("picks an enum member for a nested array item, not a placeholder string", async () => {
    // The property `human-in-the-loop` depends on: it bounds a ranking's `id` to
    // an enum of the run's candidate ids precisely so the stub has a real id to
    // pick. A placeholder here matches no candidate, and the reader — correctly
    // refusing to present input order as a ranking — kills the local run.
    const ids = ["cand-a", "cand-b", "cand-c"];
    const res = await createStubClient().llm.run({
      request: { messages: [] },
      output: {
        name: "emit_ranking",
        schema: {
          type: "object",
          properties: {
            ranking: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", enum: ids },
                  rationale: { type: "string" },
                },
                required: ["id", "rationale"],
              },
            },
          },
          required: ["ranking"],
        },
      },
    });

    const value = structuredOf<{ ranking: { id: string }[] }>(
      res,
      "emit_ranking",
    );
    expect(ids).toContain(value?.ranking[0].id);
  });

  it("still lets a step stub override the whole reply", async () => {
    const client = createStubClient({
      overrides: {
        "llm.run": {
          content: [
            {
              type: "tool_use",
              name: "emit_review",
              input: { verdict: "request_changes", summary: "Missing tests." },
            },
          ],
        },
      },
    });

    const res = await client.llm.run({
      request: { messages: [] },
      output: { name: "emit_review", schema: REVIEW_SCHEMA },
    });

    expect(structuredOf(res, "emit_review")).toEqual({
      verdict: "request_changes",
      summary: "Missing tests.",
    });
  });
});

describe("stub sandbox — handle methods templates actually call", () => {
  // A handle method with no default returned `undefined`, and the caller
  // dereferenced it: `deployPreview(...).status` threw "Cannot read properties
  // of undefined" under `run_local` instead of reporting a missing stub. These
  // are the methods `examples/` calls on a sandbox handle.
  it("returns a dereferenceable deployPreview result", async () => {
    const box = await createStubClient().sandboxes.create({ name: "s" });
    const deploy = await box.deployPreview({
      start: "node server.js",
      port: 3000,
    });

    expect(deploy.status).toBe("deployed");
    expect(typeof deploy.url).toBe("string");
    expect(typeof deploy.logs).toBe("string");
  });

  it("returns a dereferenceable createPublicUrl result", async () => {
    const box = await createStubClient().sandboxes.create({ name: "s" });
    expect(typeof (await box.createPublicUrl({ port: 3000 })).url).toBe(
      "string",
    );
  });

  it("resolves the void upload methods rather than returning undefined-shaped work", async () => {
    const box = await createStubClient().sandboxes.create({ name: "s" });
    await expect(box.uploadFile("a.txt", "hi")).resolves.toBeUndefined();
    await expect(box.uploadDir("./src")).resolves.toBeUndefined();
  });
});
