import {
  buildManifest,
  defineAgent,
  defineStep,
  fail,
  goto,
  pauseUntilSignal,
  terminate,
  agentManifestSchema,
  type AgentDefinition,
  type AgentManifest,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL } from "@sapiom/tools";

import { runLocal } from "./run-local.js";
import type { StubFile } from "./stubs.js";

function manifestFor(def: AgentDefinition): AgentManifest {
  return agentManifestSchema.parse(
    buildManifest(def, {
      sdkVersion: "0.0.0-test",
      artifact: { sha256: "x", entryFile: "def.mjs" },
    }),
  ) as AgentManifest;
}

describe("runLocal", () => {
  // The regression test: a handle-heavy workflow (the repo-helper shape) runs to
  // completion on built-in defaults — including `repo.pushFromSandbox(...)`, the
  // instance method that previously had no method body under stubs.
  it("runs a handle-using workflow to completion on defaults (incl. repo.pushFromSandbox)", async () => {
    const prepare = defineStep({
      name: "prepare",
      next: ["work"],
      async run(_input, ctx) {
        const repos = await ctx.sapiom.repositories.list();
        const repo =
          repos.find((r) => r.slug === "demo") ??
          (await ctx.sapiom.repositories.create("demo"));
        return goto("work", { slug: repo.slug, cloneUrl: repo.cloneUrl });
      },
    });
    const work = defineStep({
      name: "work",
      next: ["done"],
      canFail: true,
      async run(input: { slug: string; cloneUrl: string }, ctx) {
        const repo = ctx.sapiom.repositories.attach(input.slug, input.cloneUrl);
        const run = await ctx.sapiom.models.coding.run({
          task: "add a README",
          gitRepository: repo,
        });
        if (run.status !== "completed" || !run.result?.success)
          return fail("agent did not succeed");
        const push = await repo.pushFromSandbox(run.sandbox, {
          message: "docs",
        });
        return goto("done", { pushed: push.pushed, sandbox: run.sandbox.name });
      },
    });
    const done = defineStep({
      name: "done",
      next: [],
      terminal: true,
      async run(input: { pushed: boolean; sandbox: string }) {
        return terminate({ pushed: input.pushed, sandbox: input.sandbox });
      },
    });
    const def = defineAgent({
      name: "repo-helper",
      entry: "prepare",
      steps: { prepare, work, done },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ pushed: true, sandbox: "stub-sandbox" });
    expect(result.steps.map((s) => [s.step, s.status])).toEqual([
      ["prepare", "succeeded"],
      ["work", "succeeded"],
      ["done", "succeeded"],
    ]);
  });

  it("an override controls a branch (repositories.list returns an existing repo)", async () => {
    const prepare = defineStep({
      name: "prepare",
      next: [],
      terminal: true,
      async run(_input, ctx) {
        const repos = await ctx.sapiom.repositories.list();
        const found = repos.find((r) => r.slug === "demo");
        return terminate({ cloneUrl: found?.cloneUrl ?? "(none)" });
      },
    });
    const def = defineAgent({
      name: "find",
      entry: "prepare",
      steps: { prepare },
    });

    const stubs: StubFile = {
      version: 1,
      steps: {
        prepare: {
          "repositories.list": [
            {
              slug: "demo",
              cloneUrl: "https://git/demo.git",
              status: "active",
            },
          ],
        },
      },
    };
    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs,
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ cloneUrl: "https://git/demo.git" });
    expect(result.unusedStubs).toEqual([]); // the supplied stub key was used
  });

  it("routes a fail() directive to a failed outcome without retrying", async () => {
    let runs = 0;
    const decide = defineStep({
      name: "decide",
      next: [],
      terminal: true,
      canFail: true,
      async run(_input, ctx) {
        runs++;
        const run = await ctx.sapiom.models.coding.run({ task: "t" });
        return run.result?.success
          ? terminate({ ok: true })
          : fail("agent did not succeed");
      },
    });
    const def = defineAgent({
      name: "gate",
      entry: "decide",
      steps: { decide },
    });

    // Override the coding run to report failure → the step takes its fail() branch.
    const stubs: StubFile = {
      version: 1,
      steps: {
        decide: {
          "models.coding.run": {
            status: "failed",
            result: { success: false },
            sandbox: { name: "sb" },
          },
        },
      },
    };
    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs,
    });

    expect(result.outcome).toBe("failed");
    expect(runs).toBe(1);
  });

  // The canonical coding pattern: launch + pauseUntilSignal + resume. The local
  // runner auto-resumes with the stub coding result, so it completes locally.
  it("auto-resumes a pauseUntilSignal(launch) workflow with the stub result", async () => {
    const launch = defineStep({
      name: "launch",
      next: [],
      pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "review" },
      async run(_input, ctx) {
        return pauseUntilSignal(
          ctx.sapiom.models.coding.launch({ task: "do the thing" }),
          { resumeStep: "review" },
        );
      },
    });
    const review = defineStep({
      name: "review",
      next: [],
      terminal: true,
      async run(input) {
        // `input` is the resumed signal payload — the coding-run result.
        const r = input as { status?: string; result?: { success?: boolean } };
        return terminate({
          resumedStatus: r.status,
          success: r.result?.success,
        });
      },
    });
    const def = defineAgent({
      name: "coding-pause",
      entry: "launch",
      steps: { launch, review },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({
      resumedStatus: "completed",
      success: true,
    });
    expect(result.steps.map((s) => s.step)).toEqual(["launch", "review"]);
  });

  // The resume payload must reach the resumed step as plain JSON (a wire-faithful
  // shape), so the whole result — trace included — serializes cleanly and the step
  // re-attaches the sandbox from `executionEnvironment` exactly as in production.
  it("delivers a JSON-faithful resume payload and the full result serializes", async () => {
    const launch = defineStep({
      name: "launch",
      next: [],
      pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "finish" },
      async run(_input, ctx) {
        return pauseUntilSignal(ctx.sapiom.models.coding.launch({ task: "t" }), {
          resumeStep: "finish",
        });
      },
    });
    const finish = defineStep({
      name: "finish",
      next: [],
      terminal: true,
      async run(input: { executionEnvironment?: { id?: string } | null }, ctx) {
        // The signal payload is plain JSON, so reconstruct a live sandbox handle
        // from the executionEnvironment id before pushing.
        const sandbox = ctx.sapiom.sandboxes.attach(
          input.executionEnvironment?.id ?? "unknown",
        );
        const repo = ctx.sapiom.repositories.attach(
          "demo",
          "https://git/demo.git",
        );
        const push = await repo.pushFromSandbox(sandbox);
        return terminate({
          sandboxName: input.executionEnvironment?.id,
          pushed: push.pushed,
        });
      },
    });
    const def = defineAgent({
      name: "coding-resume",
      entry: "launch",
      steps: { launch, finish },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({
      sandboxName: "stub-sandbox",
      pushed: true,
    });
    // The resumed step's recorded input is plain data and serializes cleanly at
    // the MCP boundary (no live handles).
    const finishTrace = result.steps.find((s) => s.step === "finish");
    expect(finishTrace?.input).toMatchObject({
      executionEnvironment: { type: "blaxel_sandbox", id: "stub-sandbox" },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  // Stubbing a handle-returning capability with plain JSON must NOT strip the
  // handle's instance methods (previously `repo.pushFromSandbox` became
  // "not a function" once `repositories.attach` was overridden).
  it("keeps handle methods when a handle-returning capability is stubbed with plain JSON", async () => {
    const step = defineStep({
      name: "s",
      next: [],
      terminal: true,
      async run(_input, ctx) {
        const repo = ctx.sapiom.repositories.attach(
          "demo",
          "https://git/demo.git",
        );
        const box = ctx.sapiom.sandboxes.attach("sb");
        const push = await repo.pushFromSandbox(box);
        return terminate({ pushed: push.pushed });
      },
    });
    const def = defineAgent({
      name: "attach-json",
      entry: "s",
      steps: { s: step },
    });
    const stubs: StubFile = {
      version: 1,
      steps: {
        s: {
          "repositories.attach": {
            slug: "demo",
            cloneUrl: "https://git/demo.git",
            status: "active",
          },
        },
      },
    };
    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs,
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ pushed: true });
  });

  // A supplied stub key that no call matched is reported — here a genuine typo
  // (`models.coding.lanch`). Neither the dispatched-key pair nor any call matches
  // it, so it surfaces instead of silently no-op'ing.
  it("reports supplied stub keys that matched nothing", async () => {
    const s = defineStep({
      name: "s",
      next: [],
      pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "done" },
      async run(_input, ctx) {
        return pauseUntilSignal(ctx.sapiom.models.coding.launch({ task: "t" }), {
          resumeStep: "done",
        });
      },
    });
    const done = defineStep({
      name: "done",
      next: [],
      terminal: true,
      async run() {
        return terminate({});
      },
    });
    const def = defineAgent({
      name: "unused",
      entry: "s",
      steps: { s, done },
    });
    const stubs: StubFile = {
      version: 1,
      steps: { s: { "models.coding.lanch": { status: "completed" } } },
    };

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs,
    });

    expect(result.outcome).toBe("completed");
    expect(result.unusedStubs).toEqual([
      { step: "s", key: "models.coding.lanch" },
    ]);
  });

  // The intuitive key works: an author who calls `launch()` can stub it under
  // `models.coding.launch` (the call they wrote), not only the shared
  // `models.coding.run`. The key is consumed (not reported as unused).
  it("lets a launch() result be stubbed under models.coding.launch directly", async () => {
    const launch = defineStep({
      name: "launch",
      next: [],
      pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "review" },
      async run(_input, ctx) {
        return pauseUntilSignal(ctx.sapiom.models.coding.launch({ task: "t" }), {
          resumeStep: "review",
        });
      },
    });
    const review = defineStep({
      name: "review",
      next: [],
      terminal: true,
      async run(input: { summary?: string }) {
        return terminate({ summary: input.summary });
      },
    });
    const def = defineAgent({
      name: "launch-key",
      entry: "launch",
      steps: { launch, review },
    });
    const stubs: StubFile = {
      version: 1,
      steps: {
        launch: {
          "models.coding.launch": {
            status: "completed",
            summary: "from launch key",
            result: { success: true },
          },
        },
      },
    };

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs,
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ summary: "from launch key" });
    expect(result.unusedStubs).toEqual([]);
  });

  // The async failure path IS testable locally: the resume payload is the run
  // result, controlled by the launch/run override IN THE LAUNCHING STEP. Stubbing
  // a failed result there drives the resumed step down its failure branch.
  it("can drive the pause/resume failure branch via the launching step stub", async () => {
    const launch = defineStep({
      name: "launch",
      next: [],
      pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "finalize" },
      async run(_input, ctx) {
        return pauseUntilSignal(ctx.sapiom.models.coding.launch({ task: "t" }), {
          resumeStep: "finalize",
        });
      },
    });
    const finalize = defineStep({
      name: "finalize",
      next: [],
      terminal: true,
      canFail: true,
      async run(run: {
        status?: string;
        result?: { success?: boolean };
        error?: { message?: string };
      }) {
        if (run.status !== "completed" || !run.result?.success)
          return fail(run.error?.message ?? "agent failed");
        return terminate({ ok: true });
      },
    });
    const def = defineAgent({
      name: "coding-fail",
      entry: "launch",
      steps: { launch, finalize },
    });
    const stubs: StubFile = {
      version: 1,
      steps: {
        launch: {
          "models.coding.launch": {
            status: "failed",
            result: { success: false },
            error: { stage: "run", message: "compile error" },
          },
        },
      },
    };

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs,
    });

    expect(result.outcome).toBe("failed");
    expect(result.steps.map((s) => s.step)).toEqual(["launch", "finalize"]);
  });

  // A correctly-shaped `repositories.list` stub yields method-capable handles and
  // no warning; a malformed one (here the `[[...]]` mistake) is flagged rather
  // than silently producing repos with `slug: undefined`.
  it("coerces repositories.list elements and warns on a malformed list stub", async () => {
    const find = defineStep({
      name: "find",
      next: [],
      terminal: true,
      async run(_input, ctx) {
        const repos = await ctx.sapiom.repositories.list();
        return terminate({ slugs: repos.map((r) => r.slug) });
      },
    });
    const def = defineAgent({
      name: "list-shape",
      entry: "find",
      steps: { find },
    });

    const good = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs: {
        version: 1,
        steps: {
          find: {
            "repositories.list": [
              { slug: "demo", cloneUrl: "https://git/demo.git" },
            ],
          },
        },
      },
    });
    expect(good.output).toEqual({ slugs: ["demo"] });
    expect(good.stubWarnings).toEqual([]);

    // The classic mistake: an extra array level. Should warn, not silently null.
    const bad = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      stubs: {
        version: 1,
        steps: {
          find: {
            "repositories.list": [
              [{ slug: "demo", cloneUrl: "https://git/demo.git" }],
            ],
          },
        },
      },
    });
    expect(bad.stubWarnings.length).toBeGreaterThan(0);
    expect(bad.stubWarnings[0]).toMatch(/repositories\.list/);
  });

  it("retries a thrown step and fails at the cap", async () => {
    let runs = 0;
    const flaky = defineStep({
      name: "flaky",
      next: [],
      terminal: true,
      async run() {
        runs++;
        throw new Error("boom");
      },
    });
    const def = defineAgent({
      name: "unreliable",
      entry: "flaky",
      steps: { flaky },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
      maxAttemptsPerStep: 2,
    });

    expect(result.outcome).toBe("failed");
    expect(runs).toBe(2);
  });

  // Prod parity: the server-side run defaults an absent input to {} (run.ts:63
  // `const { definitionId, input = {} } = opts`). Local must match — an absent
  // input must NOT reach the first step as undefined. A step that reads
  // `input.topic?.trim()` would throw `Cannot read properties of undefined
  // (reading 'topic')` if input is undefined.
  it("defaults an absent input to {} so the first step never receives undefined", async () => {
    let capturedInput: unknown;
    const entry = defineStep({
      name: "entry",
      next: [],
      terminal: true,
      async run(input: { topic?: string } | undefined) {
        capturedInput = input;
        // mirrors the real failure mode: reading a property of what could be
        // undefined if the default is missing
        const trimmed = (input as { topic?: string })?.topic?.trim() ?? "(none)";
        return terminate({ trimmed });
      },
    });
    const def = defineAgent({
      name: "no-input",
      entry: "entry",
      steps: { entry },
    });

    // NOTE: `input` is intentionally omitted — this is the scenario that
    // previously crashed (undefined → Cannot read properties of undefined).
    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
    });

    expect(result.outcome).toBe("completed");
    expect(capturedInput).toEqual({});
    expect(result.output).toEqual({ trimmed: "(none)" });
  });
});
