import {
  buildManifest,
  MAX_SHARED_SNAPSHOT_BYTES,
  defineAgent,
  defineStep,
  fail,
  goto,
  pauseUntilSignal,
  terminate,
  agentManifestSchema,
  type AgentDefinition,
  type AgentExecutionContext,
  type AgentManifest,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL } from "@sapiom/tools";
import { z } from "zod/v4";

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

describe("runLocal — ctx.isLocalTrace", () => {
  /**
   * Step code holding a raw socket (a `pg` client, third-party HTTP) had no way
   * to tell a local trace from a deployed run, so it dialed for real and died on
   * a network error (SAP-2909). `ctx.isLocalTrace` is that signal.
   */
  async function gateFor(
    entryInput: unknown,
  ): Promise<{ seen: boolean | undefined; gate: boolean | undefined }> {
    let seen: boolean | undefined;
    let gate: boolean | undefined;

    const entry = defineStep({
      name: "entry",
      next: [],
      terminal: true,
      // `input` is the step's own run() argument — the value the documented
      // `input.dryRun ?? ctx.isLocalTrace` expression actually reads. Asserting
      // through ctx.input instead would not exercise what authors are told to
      // write.
      async run(input: { dryRun?: boolean }, ctx) {
        seen = ctx.isLocalTrace;
        gate = input.dryRun ?? ctx.isLocalTrace ?? false;
        return terminate({ ok: true });
      },
    });
    const def = defineAgent({
      name: "local-flag",
      entry: "entry",
      steps: { entry },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: entryInput,
    });

    // Guards the assertions below: a step that never ran would otherwise leave
    // them checking an untouched variable.
    expect(result.outcome).toBe("completed");
    return { seen, gate };
  }

  it("is true in a step running under runLocal", async () => {
    expect((await gateFor({})).seen).toBe(true);
  });

  it("makes `input.dryRun ?? ctx.isLocalTrace` skip un-stubbable I/O by default", async () => {
    expect((await gateFor({})).gate).toBe(true);
  });

  it("lets an explicit dryRun:false still force the live path", async () => {
    // The escape hatch templates rely on to exercise real I/O on purpose.
    expect((await gateFor({ dryRun: false })).gate).toBe(false);
  });

  it("leaves an explicit dryRun:true dry", async () => {
    expect((await gateFor({ dryRun: true })).gate).toBe(true);
  });
});

describe("runLocal", () => {
  it("streams start and settled evidence with timing, directive, and shared state", async () => {
    const entry = defineStep({
      name: "entry",
      next: [],
      terminal: true,
      async run(input: { topic: string }, ctx) {
        ctx.shared.set("topic", input.topic);
        ctx.logger.info("prepared result");
        return terminate({ accepted: true });
      },
    });
    const def = defineAgent({
      name: "live-evidence",
      entry: "entry",
      steps: { entry },
    });
    const events: Array<{ phase: string; trace: Record<string, unknown> }> = [];

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: { topic: "leases" },
      onStepTrace(phase, trace) {
        // Snapshot at callback time: the settled event later mutates different
        // data and must not make the start assertion pass accidentally.
        events.push({
          phase,
          trace: JSON.parse(JSON.stringify(trace)) as Record<string, unknown>,
        });
      },
    });

    expect(result.outcome).toBe("completed");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      phase: "started",
      trace: {
        step: "entry",
        attempt: 0,
        input: { topic: "leases" },
        status: "running",
        logs: [],
      },
    });
    expect(events[0]?.trace.startedAt).toEqual(expect.any(String));
    expect(events[0]?.trace).not.toHaveProperty("finishedAt");
    expect(events[1]).toMatchObject({
      phase: "settled",
      trace: {
        step: "entry",
        attempt: 0,
        status: "succeeded",
        output: { accepted: true },
        directive: { kind: "terminate", output: { accepted: true } },
        sharedStateAfter: { topic: "leases" },
        logs: [{ level: "info", msg: "prepared result" }],
      },
    });
    expect(events[1]?.trace.startedAt).toEqual(events[0]?.trace.startedAt);
    expect(events[1]?.trace.finishedAt).toEqual(expect.any(String));
  });

  it("isolates observability sink errors from the local execution", async () => {
    const entry = defineStep({
      name: "entry",
      next: [],
      terminal: true,
      async run() {
        return terminate({ ok: true });
      },
    });
    const def = defineAgent({
      name: "sink-isolation",
      entry: "entry",
      steps: { entry },
    });

    await expect(
      runLocal({
        definition: def,
        manifest: manifestFor(def),
        onStepTrace() {
          throw new Error("observer failed");
        },
      }),
    ).resolves.toMatchObject({ outcome: "completed", output: { ok: true } });
  });

  it("applies Zod defaults before author code runs", async () => {
    let capturedInput: unknown;
    const entry = defineStep({
      name: "entry",
      next: [],
      terminal: true,
      inputSchema: z.object({
        name: z.string().default("world"),
      }),
      async run(input) {
        capturedInput = input;
        return terminate({ greeting: `hello ${input.name}` });
      },
    });
    const def = defineAgent({
      name: "parsed-input",
      entry: "entry",
      steps: { entry },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
    });

    expect(result.outcome).toBe("completed");
    expect(capturedInput).toEqual({ name: "world" });
    expect(result.output).toEqual({ greeting: "hello world" });
    expect(result.steps[0]?.input).toEqual({ name: "world" });
  });

  it("parses downstream step input with its declared Zod schema", async () => {
    const start = defineStep({
      name: "start",
      next: ["finish"],
      terminal: false,
      async run() {
        return goto("finish", { value: "  hello  ", extra: true });
      },
    });
    const finish = defineStep({
      name: "finish",
      next: [],
      terminal: true,
      inputSchema: z.object({ value: z.string() }),
      async run(input) {
        return terminate(input);
      },
    });
    const def = defineAgent({
      name: "downstream-parse",
      entry: "start",
      steps: { start, finish },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: {},
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ value: "  hello  " });
    expect(result.steps[1]?.input).toEqual({ value: "  hello  " });
  });

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
        return pauseUntilSignal(
          ctx.sapiom.models.coding.launch({ task: "t" }),
          {
            resumeStep: "finish",
          },
        );
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
        return pauseUntilSignal(
          ctx.sapiom.models.coding.launch({ task: "t" }),
          {
            resumeStep: "done",
          },
        );
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
        return pauseUntilSignal(
          ctx.sapiom.models.coding.launch({ task: "t" }),
          {
            resumeStep: "review",
          },
        );
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
        return pauseUntilSignal(
          ctx.sapiom.models.coding.launch({ task: "t" }),
          {
            resumeStep: "finalize",
          },
        );
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

  it("terminalizes authoritative Zod input validation without consuming retries", async () => {
    let runs = 0;
    const validate = defineStep({
      name: "validate",
      next: [],
      terminal: true,
      // The manifest pre-gate deliberately relaxes additionalProperties while
      // this authoritative Zod schema remains strict, exercising the remote-
      // runner mismatch path rather than the engine pre-gate.
      inputSchema: z.strictObject({ allowed: z.string().optional() }),
      async run() {
        runs += 1;
        return terminate({ ok: true });
      },
    });
    const def = defineAgent({
      name: "strict-input",
      entry: "validate",
      steps: { validate },
    });

    const result = await runLocal({
      definition: def,
      manifest: manifestFor(def),
      input: { unexpected: true },
      maxAttemptsPerStep: 3,
    });

    expect(result.outcome).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      step: "validate",
      attempt: 0,
      status: "threw",
    });
    expect(result.error).toMatchObject({
      code: "STEP_INPUT_VALIDATION_FAILED",
      retryable: false,
      stepName: "validate",
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(runs).toBe(0);
  });

  it.each([
    {
      label: "an oversized candidate",
      code: "CTX_SHARED_SIZE_LIMIT_EXCEEDED",
      write(ctx: AgentExecutionContext) {
        ctx.shared.set("candidate", "x".repeat(MAX_SHARED_SNAPSHOT_BYTES));
      },
    },
    {
      label: "an unserializable candidate",
      code: "CTX_SHARED_SERIALIZATION_FAILED",
      write(ctx: AgentExecutionContext) {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        ctx.shared.set("candidate", circular);
      },
    },
  ])(
    "terminalizes $label at set time without retrying or committing it",
    async ({ code, write }) => {
      let runs = 0;
      const collect = defineStep({
        name: "collect",
        next: [],
        terminal: true,
        async run(_input, ctx) {
          runs += 1;
          ctx.shared.set("accepted", "previous value");
          write(ctx);
          return terminate({ unreachable: true });
        },
      });
      const def = defineAgent({
        name: "shared-set-gate",
        entry: "collect",
        steps: { collect },
      });

      const result = await runLocal({
        definition: def,
        manifest: manifestFor(def),
        maxAttemptsPerStep: 3,
      });

      expect(result.outcome).toBe("failed");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        step: "collect",
        attempt: 0,
        status: "threw",
        sharedStateAfter: { accepted: "previous value" },
      });
      expect(result.error).toMatchObject({
        code,
        retryable: false,
        stepName: "collect",
        phase: "ctx_shared_set",
      });
      expect(result.error).toBeInstanceOf(Error);
      expect(runs).toBe(1);
    },
  );

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
        const trimmed =
          (input as { topic?: string })?.topic?.trim() ?? "(none)";
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
