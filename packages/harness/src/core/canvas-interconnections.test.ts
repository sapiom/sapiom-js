import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectStepCapabilities, detectWorkflowLaunches } from "./canvas-interconnections.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

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
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("detectWorkflowLaunches", () => {
  it("finds an old-SDK orchestrations.launch({ definition }) call and attributes it to the enclosing step", async () => {
    const launches = await detectWorkflowLaunches(path.join(FIXTURES_DIR, "hub"), new Set(["kickoff"]));
    expect(launches).toEqual([{ slug: "spoke-workflow", fromStepId: "kickoff" }]);
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
    expect(launches).toEqual([{ slug: "applicant-lifecycle", fromStepId: "respond" }]);
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
    const launches = await detectWorkflowLaunches(dir, new Set(["classify", "respond"]));
    expect(launches).toEqual([{ slug: "downstream-flow", fromStepId: "respond" }]);
  });

  it("reports fromStepId null when the launch sits outside any known step (e.g. a shared helper)", async () => {
    const dir = await tmpProject({
      "helpers.ts": `
export async function kickOff(agents: { launch: (spec: { definition: string }) => Promise<unknown> }) {
  return agents.launch({ definition: "helper-launched" });
}
`,
    });
    const launches = await detectWorkflowLaunches(dir, new Set(["intake"]));
    expect(launches).toEqual([{ slug: "helper-launched", fromStepId: null }]);
  });

  it("finds nothing in a project with no launch calls", async () => {
    const launches = await detectWorkflowLaunches(
      path.join(FIXTURES_DIR, "order-triage"),
      new Set(["intake", "classify", "route", "auto_resolve", "escalate"]),
    );
    expect(launches).toEqual([]);
  });

  it("never throws for a directory that doesn't exist", async () => {
    await expect(detectWorkflowLaunches(path.join(FIXTURES_DIR, "does-not-exist"), new Set())).resolves.toEqual([]);
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
    const caps = await detectStepCapabilities(dir, new Set(["draft", "notify"]));
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

  it("excludes launch calls — they render as launched-workflow nodes, not capability chips", async () => {
    const dir = await tmpProject({
      "index.ts": `
const kickoff = defineStep({
  name: "kickoff",
  async run(input, ctx) {
    await ctx.sapiom.agents.launch({ definition: "child-flow" });
    await ctx.sapiom.web.search({ q: "x" });
    return terminate({});
  },
});
`,
    });
    const caps = await detectStepCapabilities(dir, new Set(["kickoff"]));
    expect(caps).toEqual([{ capability: "web.search", fromStepId: "kickoff" }]);
  });
});
