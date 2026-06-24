/**
 * Tests for manifest types, schema validation, and buildManifest generator.
 *
 * Proves:
 *   1. workflowManifestSchema validates a well-formed manifest
 *   2. workflowManifestSchema rejects invalid manifests (wrong protocol, missing fields)
 *   3. buildManifest emits the correct manifest shape from a definition
 *   4. buildManifest: step with inputSchema → JSON Schema; without → null
 *   5. buildManifest: step with timeoutMs → timeoutMs; without → null
 *   6. buildManifest: protocol is always 1, sdkVersion/artifact from opts
 */
import { z } from "zod/v4";

import { buildManifest } from "./build-manifest.js";
import { goto, pauseUntilSignal, terminate } from "./directives.js";
import {
  MANIFEST_PROTOCOL,
  type WorkflowManifest,
  workflowManifestSchema,
} from "./manifest.js";
import { defineStep } from "./step.js";
import { defineOrchestration } from "./workflow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A terminal step (declares `terminal: true`) for the schema/inputSchema/timeout tests. */
function makeStep(
  name: string,
  opts: { inputSchema?: z.ZodType; timeoutMs?: number; capability?: string } = {},
) {
  return defineStep({
    name,
    next: [],
    terminal: true,
    inputSchema: opts.inputSchema,
    timeoutMs: opts.timeoutMs,
    capability: opts.capability,
    async run() {
      return terminate(null);
    },
  });
}

const DUMMY_ARTIFACT = { sha256: "abc123", entryFile: "dist/workflow.mjs" };
const DUMMY_SDK_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// 1 + 2. workflowManifestSchema
// ---------------------------------------------------------------------------

describe("workflowManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    const manifest: WorkflowManifest = {
      protocol: MANIFEST_PROTOCOL,
      name: "my-workflow",
      entry: "step-a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "deadbeef", entryFile: "dist/my-workflow.mjs" },
      steps: {
        "step-a": {
          timeoutMs: 5000,
          inputSchema: { type: "object" },
          transitions: [{ kind: "continue", target: "step-b" }],
        },
        "step-b": {
          timeoutMs: null,
          inputSchema: null,
          transitions: [{ kind: "terminate" }],
        },
      },
    };
    expect(() => workflowManifestSchema.parse(manifest)).not.toThrow();
    const parsed = workflowManifestSchema.parse(manifest);
    expect(parsed.protocol).toBe(1);
    expect(parsed.steps["step-a"].timeoutMs).toBe(5000);
    expect(parsed.steps["step-b"].inputSchema).toBeNull();
    expect(parsed.steps["step-a"].transitions).toEqual([
      { kind: "continue", target: "step-b" },
    ]);
  });

  it("rejects a manifest with wrong protocol", () => {
    const bad = {
      protocol: 2,
      name: "wf",
      entry: "a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "x", entryFile: "f.mjs" },
      steps: {},
    };
    expect(() => workflowManifestSchema.parse(bad)).toThrow();
  });

  it("rejects a manifest missing required fields", () => {
    const missing = {
      protocol: 1,
      name: "wf",
      // missing entry, sdkVersion, artifact, steps
    };
    expect(() => workflowManifestSchema.parse(missing)).toThrow();
  });

  it("rejects a manifest with empty name", () => {
    const empty = {
      protocol: 1,
      name: "",
      entry: "a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "x", entryFile: "f.mjs" },
      steps: {},
    };
    expect(() => workflowManifestSchema.parse(empty)).toThrow();
  });

  it("rejects a non-positive timeoutMs", () => {
    const bad = {
      protocol: 1,
      name: "wf",
      entry: "a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "x", entryFile: "f.mjs" },
      steps: { a: { timeoutMs: -100, inputSchema: null, transitions: [] } },
    };
    expect(() => workflowManifestSchema.parse(bad)).toThrow();
  });

  it("rejects a step with an unknown transition kind", () => {
    const bad = {
      protocol: 1,
      name: "wf",
      entry: "a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "x", entryFile: "f.mjs" },
      steps: {
        a: {
          timeoutMs: null,
          inputSchema: null,
          transitions: [{ kind: "teleport" }],
        },
      },
    };
    expect(() => workflowManifestSchema.parse(bad)).toThrow();
  });

  it("accepts null timeoutMs (engine default)", () => {
    const good = {
      protocol: 1,
      name: "wf",
      entry: "a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "x", entryFile: "f.mjs" },
      steps: { a: { timeoutMs: null, inputSchema: null, transitions: [] } },
    };
    expect(() => workflowManifestSchema.parse(good)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 + 5 + 6. buildManifest
// ---------------------------------------------------------------------------

describe("buildManifest", () => {
  it("emits protocol=1 and passes through sdkVersion and artifact", () => {
    const def = defineOrchestration({
      name: "simple",
      entry: "start",
      steps: { start: makeStep("start") },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.protocol).toBe(1);
    expect(manifest.sdkVersion).toBe(DUMMY_SDK_VERSION);
    expect(manifest.artifact).toEqual(DUMMY_ARTIFACT);
  });

  it("carries name and entry from the definition", () => {
    const def = defineOrchestration({
      name: "my-wf",
      entry: "alpha",
      steps: { alpha: makeStep("alpha") },
    });
    const manifest = buildManifest(def, {
      sdkVersion: "1.0.0",
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.name).toBe("my-wf");
    expect(manifest.entry).toBe("alpha");
  });

  it("step without inputSchema → inputSchema: null in manifest", () => {
    const def = defineOrchestration({
      name: "wf",
      entry: "plain",
      steps: { plain: makeStep("plain") },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.steps.plain.inputSchema).toBeNull();
  });

  it("step without timeoutMs → timeoutMs: null in manifest", () => {
    const def = defineOrchestration({
      name: "wf",
      entry: "plain",
      steps: { plain: makeStep("plain") },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.steps.plain.timeoutMs).toBeNull();
  });

  it("step with inputSchema → schema converted to JSON Schema", () => {
    const schema = z.object({ userId: z.string(), count: z.number() });
    const def = defineOrchestration({
      name: "wf",
      entry: "validated",
      steps: { validated: makeStep("validated", { inputSchema: schema }) },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    const stepSchema = manifest.steps.validated.inputSchema;
    expect(stepSchema).not.toBeNull();
    expect(stepSchema?.type).toBe("object");
    expect(
      (stepSchema?.properties as Record<string, unknown>)?.userId,
    ).toBeDefined();
    expect(
      (stepSchema?.properties as Record<string, unknown>)?.count,
    ).toBeDefined();
  });

  it("step with timeoutMs → timeoutMs carried through", () => {
    const def = defineOrchestration({
      name: "wf",
      entry: "slow",
      steps: { slow: makeStep("slow", { timeoutMs: 30_000 }) },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.steps.slow.timeoutMs).toBe(30_000);
  });

  it("multi-step definition: each step independently mapped", () => {
    const inputSchema = z.object({ topic: z.string() });
    const def = defineOrchestration({
      name: "multi",
      entry: "gather",
      steps: {
        gather: makeStep("gather", { inputSchema, timeoutMs: 10_000 }),
        summarize: makeStep("summarize", { timeoutMs: 20_000 }),
        finalize: makeStep("finalize"),
      },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });

    // gather: has both schema and timeout
    expect(manifest.steps.gather.timeoutMs).toBe(10_000);
    expect(manifest.steps.gather.inputSchema).not.toBeNull();
    expect(manifest.steps.gather.inputSchema?.type).toBe("object");

    // summarize: timeout but no schema
    expect(manifest.steps.summarize.timeoutMs).toBe(20_000);
    expect(manifest.steps.summarize.inputSchema).toBeNull();

    // finalize: neither
    expect(manifest.steps.finalize.timeoutMs).toBeNull();
    expect(manifest.steps.finalize.inputSchema).toBeNull();
  });

  it("defaulted field is NOT in required in the manifest JSON Schema (AJV pre-check must not be stricter than Zod)", () => {
    // `count` has a Zod default → zod.toJSONSchema marks it required; buildManifest
    // must strip it so a caller that omits `count` passes AJV pre-check.
    // Only top-level `required` entries are treated (nested objects out of scope for v1).
    const schema = z.object({
      name: z.string(),
      count: z.number().default(0),
    });
    const def = defineOrchestration({
      name: "wf",
      entry: "step",
      steps: { step: makeStep("step", { inputSchema: schema }) },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    const stepSchema = manifest.steps.step.inputSchema!;
    const required = stepSchema.required as string[] | undefined;
    // `name` (no default) must still be required; `count` (has default) must not be.
    expect(required).toBeDefined();
    expect(required).toContain("name");
    expect(required).not.toContain("count");
  });

  it("strips additionalProperties:false from the schema (top-level AND nested) so inputs with extra fields are accepted", () => {
    // z.toJSONSchema marks every object as closed (additionalProperties:false).
    // A plain z.object() parse ignores extra keys rather than rejecting them, so
    // buildManifest relaxes the generated schema to match — keeping it
    // forward-compatible with inputs that gain fields over time.
    const schema = z.object({
      runId: z.string(),
      result: z.object({ success: z.boolean() }).nullable(),
    });
    const def = defineOrchestration({
      name: "wf",
      entry: "review",
      steps: { review: makeStep("review", { inputSchema: schema }) },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    const stepSchema = manifest.steps.review.inputSchema!;

    // No `additionalProperties: false` anywhere in the emitted schema.
    const hasStrict = JSON.stringify(stepSchema).includes(
      '"additionalProperties":false',
    );
    expect(hasStrict).toBe(false);
    // Sanity: the schema is otherwise intact (named properties + required preserved).
    expect(
      (stepSchema.properties as Record<string, unknown>).runId,
    ).toBeDefined();
    expect(stepSchema.required).toContain("runId");
  });

  it("manifest validates against workflowManifestSchema", () => {
    const inputSchema = z.object({ input: z.string() });
    const def = defineOrchestration({
      name: "validated-wf",
      entry: "entry",
      steps: {
        entry: makeStep("entry", { inputSchema }),
        exit: makeStep("exit", { timeoutMs: 5000 }),
      },
    });
    const manifest = buildManifest(def, {
      sdkVersion: "0.1.0",
      artifact: DUMMY_ARTIFACT,
    });

    // Parse with the zod schema — must not throw
    const parsed = workflowManifestSchema.parse(manifest);
    expect(parsed.name).toBe("validated-wf");
    expect(parsed.steps.entry.inputSchema).not.toBeNull();
    expect(parsed.steps.exit.timeoutMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// buildManifest — transitions emission (the build-derivable graph edges)
// ---------------------------------------------------------------------------

describe("buildManifest transitions", () => {
  // A four-step graph exercising every transition kind:
  //   prep -> enrich -> approval (pause→finalize) -> finalize (terminate|fail)
  const def = defineOrchestration({
    name: "graph",
    entry: "prep",
    steps: {
      prep: defineStep({
        name: "prep",
        next: ["enrich"],
        async run() {
          return goto("enrich");
        },
      }),
      enrich: defineStep({
        name: "enrich",
        next: ["approval", "finalize"],
        async run() {
          return goto("approval");
        },
      }),
      approval: defineStep({
        name: "approval",
        next: ["finalize"],
        pause: { signal: "demo.approval", resumeStep: "finalize" },
        async run() {
          return pauseUntilSignal({
            signal: "demo.approval",
            resumeStep: "finalize",
          });
        },
      }),
      finalize: defineStep({
        name: "finalize",
        next: [],
        terminal: true,
        canFail: true,
        async run() {
          return terminate({ done: true });
        },
      }),
    },
  });
  const manifest = buildManifest(def, {
    sdkVersion: "0.1.0",
    artifact: DUMMY_ARTIFACT,
  });

  it("emits one continue transition per next entry", () => {
    expect(manifest.steps.prep.transitions).toEqual([
      { kind: "continue", target: "enrich" },
    ]);
    expect(manifest.steps.enrich.transitions).toEqual([
      { kind: "continue", target: "approval" },
      { kind: "continue", target: "finalize" },
    ]);
  });

  it("emits a pause transition with signal + resumeStep", () => {
    expect(manifest.steps.approval.transitions).toContainEqual({
      kind: "pause",
      signal: "demo.approval",
      resumeStep: "finalize",
    });
  });

  it("emits terminate and fail transitions for a terminal+canFail step", () => {
    expect(manifest.steps.finalize.transitions).toEqual([
      { kind: "terminate" },
      { kind: "fail" },
    ]);
  });

  it("does NOT emit a retry transition (retry is a universal badge, not an edge)", () => {
    for (const step of Object.values(manifest.steps)) {
      expect(
        step.transitions.some((t) => (t as { kind: string }).kind === "retry"),
      ).toBe(false);
    }
  });

  it("produces a manifest that validates against the schema", () => {
    expect(() => workflowManifestSchema.parse(manifest)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildManifest — capability binding (the declared step→capability id)
// ---------------------------------------------------------------------------

describe("buildManifest capability binding", () => {
  it("emits the declared capability as the step's canonical dotted capabilityId", () => {
    const def = defineOrchestration({
      name: "wf",
      entry: "search",
      steps: { search: makeStep("search", { capability: "web.search" }) },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.steps.search.capabilityId).toBe("web.search");
  });

  it("emits capabilityId: null for a step that declares no capability (runs in-process)", () => {
    const def = defineOrchestration({
      name: "wf",
      entry: "plain",
      steps: { plain: makeStep("plain") },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.steps.plain.capabilityId).toBeNull();
  });

  it("maps each step's capability independently across a multi-step definition", () => {
    const def = defineOrchestration({
      name: "multi",
      entry: "search",
      steps: {
        search: defineStep({
          name: "search",
          next: ["code"],
          capability: "web.search",
          async run() {
            return goto("code");
          },
        }),
        code: defineStep({
          name: "code",
          next: ["done"],
          capability: "agent.coding.run",
          async run() {
            return goto("done");
          },
        }),
        done: makeStep("done"),
      },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    expect(manifest.steps.search.capabilityId).toBe("web.search");
    expect(manifest.steps.code.capabilityId).toBe("agent.coding.run");
    expect(manifest.steps.done.capabilityId).toBeNull();
  });

  it("a manifest carrying a capabilityId validates against the schema", () => {
    const def = defineOrchestration({
      name: "wf",
      entry: "search",
      steps: { search: makeStep("search", { capability: "web.search" }) },
    });
    const manifest = buildManifest(def, {
      sdkVersion: DUMMY_SDK_VERSION,
      artifact: DUMMY_ARTIFACT,
    });
    const parsed = workflowManifestSchema.parse(manifest);
    expect(parsed.steps.search.capabilityId).toBe("web.search");
  });

  it("schema accepts a step manifest that omits capabilityId (back-compat)", () => {
    const legacy = {
      protocol: MANIFEST_PROTOCOL,
      name: "wf",
      entry: "a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "x", entryFile: "f.mjs" },
      // no capabilityId on the step — a manifest built before the field existed
      steps: { a: { timeoutMs: null, inputSchema: null, transitions: [] } },
    };
    expect(() => workflowManifestSchema.parse(legacy)).not.toThrow();
  });

  it("schema rejects an empty-string capabilityId (declared ids are non-empty)", () => {
    const bad = {
      protocol: MANIFEST_PROTOCOL,
      name: "wf",
      entry: "a",
      sdkVersion: "0.1.0",
      artifact: { sha256: "x", entryFile: "f.mjs" },
      steps: {
        a: { timeoutMs: null, inputSchema: null, capabilityId: "", transitions: [] },
      },
    };
    expect(() => workflowManifestSchema.parse(bad)).toThrow();
  });
});
