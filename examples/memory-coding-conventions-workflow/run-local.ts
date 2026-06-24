/**
 * run-local.ts — the LOCAL RUNNER / harness for the workflow in `index.ts`.
 *
 * `index.ts` is the deployable artifact (side-effect-free). This file is the dev
 * harness that exercises it locally, two ways:
 *
 *   pnpm start                       → STUB mode  (default; offline, free, works today)
 *   pnpm start:live                  → LIVE mode  (real LOCAL memory gateway; x402-paid)
 *
 * Flags / env:
 *   --mode stub|live   (default: stub)
 *   --task "<text>"    (default: a sensible demo task)
 *   --repo "<slug>"    (default: "api")
 *   DEMO_SCENARIO=skip (stub mode only) — uses a stronger prior so the SKIP branch runs.
 *
 * The third way the SAME `index.ts` runs — Sapiom execution inside a Blaxel
 * sandbox — needs no code here; see the README RUN MODE 3.
 */
import {
  buildManifest,
  isContinue,
  isTerminate,
  isFail,
  isRetry,
  isPause,
  InMemoryContextStore,
  type StepDefinition,
  type OrchestrationExecutionContext,
} from "@sapiom/orchestration";
import { runLocal, type StubFile } from "@sapiom/orchestration-core";
import { createClient, type Sapiom } from "@sapiom/tools";

import { orchestration, type WorkflowInput, type Shared } from "./index.js";

const SCOPE = "house-conventions";

// ---------------------------------------------------------------------------
// argv / env
// ---------------------------------------------------------------------------

interface Args {
  mode: "stub" | "live";
  task: string;
  repo: string;
}

function parseArgs(argv: string[]): Args {
  let mode: "stub" | "live" = "stub";
  let task = "Add a POST /users endpoint that creates a user.";
  let repo = "api";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") mode = argv[++i] === "live" ? "live" : "stub";
    else if (a === "--task") task = argv[++i] ?? task;
    else if (a === "--repo") repo = argv[++i] ?? repo;
  }
  return { mode, task, repo };
}

// ---------------------------------------------------------------------------
// STUB MODE — runLocal + canned stubs. Offline, free, works today.
// ---------------------------------------------------------------------------

/**
 * The golden rule: only stub what a step BRANCHES ON or what a downstream step
 * CONSUMES. For this workflow that's three calls:
 *   - recall.memory.recall — `apply` branches on `topMatch` + `combinedScore`.
 *   - learn.memory.append  — `verify` consumes the returned `id`.
 *   - verify.memory.get    — its `status` lands in the terminal output.
 * `apply` and `skip` make no capability calls, so they have nothing to stub.
 *
 * Two scenarios:
 *   default        — a weak prior (combinedScore < 0.8) → apply takes the LEARN branch.
 *   DEMO_SCENARIO=skip — a strong prior (combinedScore >= 0.8) → apply takes the SKIP branch.
 * This shows BOTH sides of the real branch from the same artifact.
 */
function buildStubs(takeSkipBranch: boolean): StubFile {
  // The prior memory `recall` returns. Its `combinedScore` is what `apply`
  // branches on (>= 0.8 ⇒ "already known" ⇒ skip; otherwise ⇒ learn).
  const prior = {
    id: "mem_prior_1",
    content: "Validate every request body with a zod schema before using it.",
    scope: SCOPE,
    vectorScore: takeSkipBranch ? 0.95 : 0.6,
    textScore: takeSkipBranch ? 0.9 : 0.4,
    combinedScore: takeSkipBranch ? 0.92 : 0.55,
    status: "active",
    createdAt: "2026-06-01T00:00:00Z",
    metadata: {},
  };

  return {
    version: 1,
    steps: {
      recall: {
        "memory.recall": {
          results: [prior],
          query: "stubbed",
          topK: 5,
          count: 1,
        },
      },
      // Consumed by `verify` (its `id`). Only reached on the LEARN branch.
      learn: {
        "memory.append": {
          id: "mem_stub_1",
          content: "stubbed convention",
          scope: SCOPE,
          status: "active",
          decision: "ADDED",
          supersededId: null,
          similarityScore: null,
          createdAt: "2026-06-24T00:00:00Z",
          metadata: { source: "memory-coding-conventions-workflow" },
        },
      },
      // Read back by `verify`. Only reached on the LEARN branch.
      verify: {
        "memory.get": {
          id: "mem_stub_1",
          content: "stubbed convention",
          scope: SCOPE,
          status: "active",
          supersededBy: null,
          supersededReason: null,
          createdAt: "2026-06-24T00:00:00Z",
          updatedAt: "2026-06-24T00:00:00Z",
          metadata: { source: "memory-coding-conventions-workflow" },
        },
      },
    },
  };
}

async function runStub(args: Args): Promise<void> {
  // The build phase produces this manifest in production; we build it inline.
  const manifest = buildManifest(orchestration, {
    sdkVersion: "0.0.0-example",
    artifact: { sha256: "example", entryFile: "index.ts" },
  });

  const takeSkipBranch = process.env.DEMO_SCENARIO === "skip";
  const stubs = buildStubs(takeSkipBranch);

  console.log(
    `\n=== STUB MODE (offline) — scenario: ${takeSkipBranch ? "skip (strong prior)" : "learn (weak prior)"} ===`,
  );

  const result = await runLocal({
    definition: orchestration,
    manifest,
    input: { repoSlug: args.repo, task: args.task } satisfies WorkflowInput,
    stubs,
  });

  // ----- print the trace so you can watch recall → apply → {learn → verify | skip} -----
  console.log(`\nworkflow "${orchestration.name}" → ${result.outcome}\n`);
  for (const step of result.steps) {
    console.log(`▶ ${step.step} (${step.status})`);
    for (const entry of step.logs) {
      const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
      console.log(`    · ${entry.msg}${meta}`);
    }
  }
  console.log(`\nfinal output: ${JSON.stringify(result.output, null, 2)}`);

  if (result.unusedStubs.length > 0) {
    console.log(`\n⚠ unused stubs:`, result.unusedStubs);
  }
  if (result.stubWarnings.length > 0) {
    console.log(`\n⚠ stub warnings:`, result.stubWarnings);
  }
  if (result.unusedStubs.length === 0 && result.stubWarnings.length === 0) {
    console.log(`\n✓ no unused stubs, no stub warnings`);
  }
}

// ===========================================================================
// DEV HARNESS — reproduces the engine's step-walk so the workflow runs against
// the real LOCAL gateway. In production the Sapiom engine runs these identical
// step bodies inside a Blaxel sandbox; this walker is for local dev only.
// NOTE: this harness does NOT validate each step's `inputSchema` before run()
// (the real engine does) — it is a faithful-enough step driver, not full parity.
// ===========================================================================

function assertLiveEnv(): void {
  if (!process.env.SAPIOM_API_KEY) {
    throw new Error("LIVE mode requires SAPIOM_API_KEY (a real Sapiom API key from your local backend).");
  }
  if (!process.env.SAPIOM_MEMORY_URL) {
    throw new Error(
      "LIVE mode requires SAPIOM_MEMORY_URL (e.g. http://memory.services.localhost:3100). " +
        "createClient() does not take a base URL — the memory client reads it from this env var.",
    );
  }
}

/**
 * Build a `ctx` that satisfies `OrchestrationExecutionContext`: a Map-backed
 * shared store (via the SDK's `InMemoryContextStore`), a console-backed logger,
 * a derived (non-random) executionId, and a REAL `ctx.sapiom`.
 */
function buildLiveCtx(sapiom: Sapiom, input: WorkflowInput): OrchestrationExecutionContext<Shared> {
  const shared = new InMemoryContextStore<Shared>();
  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) =>
      console.log(`    · ${msg}${meta ? " " + JSON.stringify(meta) : ""}`),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      console.warn(`    · [warn] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`),
    error: (msg: string, meta?: Record<string, unknown>) =>
      console.error(`    · [error] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`),
    debug: (msg: string, meta?: Record<string, unknown>) =>
      console.debug(`    · [debug] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`),
  };
  return {
    executionId: `local-dev-${process.pid}`,
    workflowName: orchestration.name,
    organizationId: null,
    tenantId: null,
    input,
    shared,
    history: [],
    attempts: 0,
    logger,
    sapiom,
  };
}

async function runLive(args: Args): Promise<void> {
  assertLiveEnv();
  console.log(`\n=== LIVE MODE — against ${process.env.SAPIOM_MEMORY_URL} ===`);

  // REAL client. NOTE: createClient takes only an apiKey; the memory base URL is
  // resolved by @sapiom/tools from SAPIOM_MEMORY_URL (asserted above).
  const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
  const input: WorkflowInput = { repoSlug: args.repo, task: args.task };
  const ctx = buildLiveCtx(sapiom, input);

  // The dev walker: start at the entry step and follow the directives the SAME
  // step bodies return, exactly as the engine would.
  const steps = orchestration.steps as Record<string, StepDefinition<Shared>>;
  let name: string = orchestration.entry;
  let currentInput: unknown = input;
  const MAX_ATTEMPTS = 3;
  const MAX_STEPS = 100;

  for (let i = 0; i < MAX_STEPS; i++) {
    const step = steps[name];
    if (!step) throw new Error(`live walker: no step '${name}' in the definition`);
    console.log(`▶ ${name}`);

    // retry loop with an attempt cap, mirroring the engine's maxAttemptsPerStep.
    let directive;
    let attempt = 0;
    for (;;) {
      directive = await step.run(currentInput, ctx);
      if (!isRetry(directive)) break;
      if (++attempt >= MAX_ATTEMPTS) {
        throw new Error(`live walker: step '${name}' exceeded ${MAX_ATTEMPTS} retries`);
      }
      console.log(`    · retry (${directive.reason ?? "no reason"})`);
    }

    if (isContinue(directive)) {
      // Goto: stepName = next step, input = this step's output AND next step's input.
      name = directive.stepName;
      currentInput = directive.input;
      continue;
    }
    if (isTerminate(directive)) {
      // The narrowed wire `TerminateDirective` doesn't carry `output` (it rides on
      // the branded `terminate()` value the step returned). Read it the same way
      // the SDK's own dispatcher does — off the runtime object.
      const output = (directive as { output?: unknown }).output;
      console.log(`\nworkflow → completed (${directive.reason ?? "no reason"})`);
      console.log(`final output: ${JSON.stringify(output, null, 2)}`);
      return;
    }
    if (isFail(directive)) {
      const output = (directive as { output?: unknown }).output;
      console.log(`\nworkflow → failed: ${directive.reason ?? "no reason"}`);
      if (output !== undefined) {
        console.log(`failure output: ${JSON.stringify(output, null, 2)}`);
      }
      process.exitCode = 1;
      return;
    }
    if (isPause(directive)) {
      throw new Error("pause not supported in live-local (no pause steps in this demo)");
    }
    throw new Error(`live walker: unrecognized directive kind '${(directive as { kind: string }).kind}'`);
  }
  throw new Error(`live walker: exceeded ${MAX_STEPS} steps (non-terminating graph?)`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "live") {
    await runLive(args);
  } else {
    await runStub(args);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
