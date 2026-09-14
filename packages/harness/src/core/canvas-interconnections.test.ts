import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectAgentInvocations,
  detectStepCapabilities,
  detectWorkflowLaunches,
  listSourceFilesWithObservations,
} from "./canvas-interconnections.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);

const tmpDirs: string[] = [];
async function tmpProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-launches-test-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe("source symlink boundaries", () => {
  it.each(["node_modules", ".git", "dist", "build", ".sapiom"])(
    "ignores linked %s directories without degrading owned sources",
    async (name) => {
      const dir = await tmpProject({ "index.ts": "export const own = true;" });
      const outside = await tmpProject({
        "external.ts": "export const external = true;",
      });
      await fs.symlink(outside, path.join(dir, name), "junction");
      const found = await listSourceFilesWithObservations(dir);
      expect(found.complete).toBe(true);
      expect(found.files).toEqual([path.join(dir, "index.ts")]);
      expect(found.observedPaths).not.toContain(outside);
    },
  );

  it("keeps unknown directory and source-file links incomplete without following them", async () => {
    const dir = await tmpProject({ "index.ts": "export const own = true;" });
    const outside = await tmpProject({
      "external.ts": "export const external = true;",
    });
    await fs.symlink(outside, path.join(dir, "shared"), "junction");
    await fs.symlink(
      path.join(outside, "external.ts"),
      path.join(dir, "linked.ts"),
    );
    const found = await listSourceFilesWithObservations(dir);
    expect(found.complete).toBe(false);
    expect(found.files).toEqual([path.join(dir, "index.ts")]);
    expect(found.observedPaths).not.toContain(outside);
  });
});

describe("detectWorkflowLaunches", () => {
  it("keeps the launch-only compatibility result used by the per-agent Canvas", async () => {
    const dir = await tmpProject({
      "index.ts": `
const kickoff = defineStep({
  name: "kickoff",
  async run(input, ctx) {
    await ctx.sapiom.agents.run({ definition: "blocking-child" });
    await ctx.sapiom.agents.launch({ definition: "async-child" });
  },
});
`,
    });

    await expect(
      detectWorkflowLaunches(dir, new Set(["kickoff"])),
    ).resolves.toEqual([{ slug: "async-child", fromStepId: "kickoff" }]);
  });

  it("finds a new-SDK ctx.sapiom.agents.launch({ definition }) call — the shape the rename introduced", async () => {
    const dir = await tmpProject({
      "index.ts": `
const respond = defineStep({
  name: "respond",
  terminal: true,
  async run(input, ctx) {
    const child = await ctx.sapiom.agents.launch({
      definition: 'applicant-lifecycle',
      input: { applicantEmail: "x@example.com" },
    });
    return terminate({ child });
  },
});
`,
    });
    const launches = await detectWorkflowLaunches(dir, new Set(["respond"]));
    expect(launches).toEqual([
      { slug: "applicant-lifecycle", fromStepId: "respond" },
    ]);
  });

  it("attributes each launch to the nearest preceding known step, ignoring name-lookalike properties", async () => {
    const dir = await tmpProject({
      "index.ts": `
const classify = defineStep({
  name: "classify",
  next: ["respond"],
  async run(input) {
    // fromName / vendorName must never be mistaken for a step declaration.
    const meta = { fromName: "Someone", vendorName: "Acme" };
    return goto("respond", meta);
  },
});
const respond = defineStep({
  name: "respond",
  terminal: true,
  async run(input, ctx) {
    await ctx.sapiom.agents.launch({ definition: "downstream-flow", input: {} });
    return terminate({});
  },
});
`,
    });
    const launches = await detectWorkflowLaunches(
      dir,
      new Set(["classify", "respond"]),
    );
    expect(launches).toEqual([
      { slug: "downstream-flow", fromStepId: "respond" },
    ]);
  });

  it("does not treat an arbitrary typed helper parameter as the Sapiom agents namespace", async () => {
    const dir = await tmpProject({
      "helpers.ts": `
export async function kickOff(agents: { launch: (spec: { definition: string }) => Promise<unknown> }) {
  return agents.launch({ definition: "helper-launched" });
}
`,
    });
    const launches = await detectWorkflowLaunches(dir, new Set(["intake"]));
    expect(launches).toEqual([]);
  });

  it("finds nothing in a project with no launch calls", async () => {
    const launches = await detectWorkflowLaunches(
      path.join(FIXTURES_DIR, "order-triage"),
      new Set(["intake", "classify", "route", "auto_resolve", "escalate"]),
    );
    expect(launches).toEqual([]);
  });

  it("never throws for a directory that doesn't exist", async () => {
    await expect(
      detectWorkflowLaunches(
        path.join(FIXTURES_DIR, "does-not-exist"),
        new Set(),
      ),
    ).resolves.toEqual([]);
  });
});

describe("detectAgentInvocations", () => {
  it("classifies current context calls by authored method and records relative source evidence", async () => {
    const dir = await tmpProject({
      "nested/index.ts": `// line one
ctx.sapiom.agents.run({ definition: "blocking-child" });
ctx.sapiom.agents.launch({ definition: "async-child" });
`,
    });

    const result = await detectAgentInvocations(dir, new Set());

    expect(result).toEqual({
      invocations: [
        {
          slug: "blocking-child",
          mode: "blocking",
          fromStepId: null,
          evidence: { file: "nested/index.ts", line: 2, column: 1 },
        },
        {
          slug: "async-child",
          mode: "async",
          fromStepId: null,
          evidence: { file: "nested/index.ts", line: 3, column: 1 },
        },
      ],
      warnings: [],
      observedPaths: [
        dir,
        path.join(dir, "nested"),
        path.join(dir, "nested", "index.ts"),
      ],
      complete: true,
    });
  });

  it("detects proven current aliases and the legacy orchestration import", async () => {
    const dir = await tmpProject({
      "index.ts": `
import {
  agents,
  agents as childAgents,
  orchestrations as legacyOrchestrations,
} from "@sapiom/tools";

agents.run({ definition: "one" });
childAgents.launch({ definition: "two" });
legacyOrchestrations.launch({ definition: "three" });
`,
    });

    const result = await detectAgentInvocations(dir, new Set());

    expect(
      result.invocations.map(({ slug, mode }) => ({ slug, mode })),
    ).toEqual([
      { slug: "one", mode: "blocking" },
      { slug: "two", mode: "async" },
      { slug: "three", mode: "async" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("does not follow an imported namespace name through lexical shadowing", async () => {
    const dir = await tmpProject({
      "index.ts": `
import { agents } from "@sapiom/tools";
agents.run({ definition: "proven-import" });

function parameterShadow(agents: { launch(spec: unknown): unknown }) {
  return agents.launch({ definition: "parameter-lookalike" });
}
function localShadow() {
  const agents = { run(spec: unknown) { return spec; } };
  return agents.run({ definition: "local-lookalike" });
}
`,
    });

    const result = await detectAgentInvocations(dir, new Set());

    expect(result.invocations.map(({ slug }) => slug)).toEqual([
      "proven-import",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("walks supported calls in TSX source without interpreting JSX text", async () => {
    const dir = await tmpProject({
      "view.tsx": `
export function View(ctx: { sapiom: any }) {
  ctx.sapiom.agents.launch({ definition: "tsx-child" });
  return <pre>{'ctx.sapiom.agents.run({ definition: "jsx-text" })'}</pre>;
}
`,
    });

    const result = await detectAgentInvocations(dir, new Set());

    expect(
      result.invocations.map(({ slug, mode, evidence }) => ({
        slug,
        mode,
        file: evidence.file,
      })),
    ).toEqual([{ slug: "tsx-child", mode: "async", file: "view.tsx" }]);
    expect(result.warnings).toEqual([]);
  });

  it("reads only a direct definition property and accepts harmless TypeScript wrappers", async () => {
    const dir = await tmpProject({
      "index.ts": `
ctx.sapiom.agents.run(({
  input: { definition: "nested-lookalike" },
  definition: \`direct-template\`,
}) satisfies Record<string, unknown>);
ctx.sapiom.agents.launch({
  input: { definition: "also-wrong" },
  definition: ("direct-string" as const),
});
`,
    });

    const result = await detectAgentInvocations(dir, new Set());

    expect(
      result.invocations.map(({ slug, mode }) => ({ slug, mode })),
    ).toEqual([
      { slug: "direct-template", mode: "blocking" },
      { slug: "direct-string", mode: "async" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("warns for supported calls with dynamic, missing, or spread-only targets", async () => {
    const dir = await tmpProject({
      "index.ts": `
ctx.sapiom.agents.run({ definition: chooseAgent() });
ctx.sapiom.agents.launch({ definition: \`child-\${suffix}\` });
ctx.sapiom.agents.run({ input: {} });
ctx.sapiom.agents.launch({ ...options });
`,
    });

    const result = await detectAgentInvocations(dir, new Set());

    expect(result.invocations).toEqual([]);
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        {
          code: "dynamic-target",
          mode: "blocking",
          evidence: { file: "index.ts", line: 2, column: 1 },
        },
        {
          code: "dynamic-target",
          mode: "async",
          evidence: { file: "index.ts", line: 3, column: 1 },
        },
      ]),
    );
  });

  it("ignores comments, strings, unrelated APIs, local lookalikes, and helper parameters", async () => {
    const dir = await tmpProject({
      "index.ts": `
// ctx.sapiom.agents.run({ definition: "comment" });
const example = 'ctx.sapiom.agents.launch({ definition: "string" })';
const docs = \`ctx.sapiom.agents.run({ definition: "template text" })\`;
other.sapiom.agents.run({ definition: "other-context" });
client.agents.launch({ definition: "other-client" });
const agents = { run() {}, launch() {} };
agents.run({ definition: "local-lookalike" });
function helper(agents: { launch(spec: unknown): unknown }) {
  return agents.launch({ definition: "helper-parameter" });
}
`,
    });

    await expect(detectAgentInvocations(dir, new Set())).resolves.toEqual({
      invocations: [],
      warnings: [],
      observedPaths: [dir, path.join(dir, "index.ts")],
      complete: true,
    });
  });
});

describe("listSourceFilesWithObservations", () => {
  it("bounds a broad empty-directory tree and marks the scan incomplete", async () => {
    const dir = await tmpProject({ "index.ts": "export const value = 1;\n" });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        fs.mkdir(path.join(dir, `directory-${String(index).padStart(2, "0")}`)),
      ),
    );

    const result = await listSourceFilesWithObservations(dir, {
      maxDirectories: 4,
    });

    expect(result.complete).toBe(false);
    expect(
      result.observedPaths.filter((observed) =>
        result.files.includes(observed) ? false : true,
      ),
    ).toHaveLength(4);
    expect(result.files).toEqual([path.join(dir, "index.ts")]);
  });

  it("uses a deterministic depth boundary instead of recursing indefinitely", async () => {
    const dir = await tmpProject({
      "one/two/three/index.ts": "export const value = 1;\n",
    });

    const result = await listSourceFilesWithObservations(dir, { maxDepth: 1 });

    expect(result.complete).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.observedPaths).toEqual([dir, path.join(dir, "one")]);
  });

  it("bounds candidates and observations in one very large directory", async () => {
    const dir = await tmpProject(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `source-${String(index).padStart(2, "0")}.ts`,
          `export const value${index} = ${index};\n`,
        ]),
      ),
    );

    const first = await listSourceFilesWithObservations(dir, {
      maxFiles: 4,
      maxEntries: 6,
    });
    const second = await listSourceFilesWithObservations(dir, {
      maxFiles: 4,
      maxEntries: 6,
    });

    expect(first.complete).toBe(false);
    expect(first.files).toEqual([]);
    expect(first.observedPaths).toEqual([dir]);
    expect(second).toEqual(first);
  });
});

describe("detectStepCapabilities", () => {
  it("attributes each ctx.sapiom.*() call to the step whose defineStep block it sits in", async () => {
    const dir = await tmpProject({
      "index.ts": `
const draft = defineStep({
  name: "draft",
  async run(input, ctx) {
    const reply = await ctx.sapiom.models.run({ prompt: "hi" });
    return goto("notify", { reply });
  },
});
const notify = defineStep({
  name: "notify",
  terminal: true,
  async run(input, ctx) {
    await ctx.sapiom.email.messages.send({ to: "x@y.z" });
    return terminate({});
  },
});
`,
    });
    const caps = await detectStepCapabilities(
      dir,
      new Set(["draft", "notify"]),
    );
    expect(caps).toEqual([
      { capability: "models.run", fromStepId: "draft" },
      { capability: "email.messages.send", fromStepId: "notify" },
    ]);
  });

  it("does NOT attribute a call in a trailing helper to the last step — a wrong chip is a false billing claim", async () => {
    const dir = await tmpProject({
      "index.ts": `
const classify = defineStep({
  name: "classify",
  terminal: true,
  async run(input, ctx) {
    return terminate({ label: categorize(input) });
  },
});

// A helper BELOW the last step — its sapiom call must stay UNattributed
// (fromStepId null), not get billed to "classify".
function categorize(input) {
  return sapiom.rules.classify({ input });
}
`,
    });
    const caps = await detectStepCapabilities(dir, new Set(["classify"]));
    expect(caps).toEqual([{ capability: "rules.classify", fromStepId: null }]);
  });

  it("keeps the blocking run chip until the per-agent Canvas can render it as an invocation", async () => {
    const dir = await tmpProject({
      "index.ts": `
const kickoff = defineStep({
  name: "kickoff",
  async run(input, ctx) {
    await ctx.sapiom.agents.run({ definition: "blocking-child" });
    await ctx.sapiom.agents.launch({ definition: "child-flow" });
    await ctx.sapiom.web.search({ q: "x" });
    return terminate({});
  },
});
`,
    });
    const caps = await detectStepCapabilities(dir, new Set(["kickoff"]));
    expect(caps).toEqual([
      { capability: "agents.run", fromStepId: "kickoff" },
      { capability: "web.search", fromStepId: "kickoff" },
    ]);
  });
});
