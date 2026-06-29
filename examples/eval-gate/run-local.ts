/**
 * run-local.ts — the LOCAL RUNNER / harness for the eval-gate in `index.ts`.
 *
 * `index.ts` is the deployable artifact (side-effect-free). This file is the dev
 * harness that exercises it locally, two ways:
 *
 *   pnpm start            → OFFLINE mode (default; fakes the gateway HTTP, free)
 *   pnpm start:live       → LIVE mode    (real Sapiom LLM gateway via LLM_GATEWAY_*)
 *
 * Flags / env:
 *   --mode offline|live   (default: offline)
 *   --rubric "<text>"     (the criteria the judge scores against)
 *   --output "<text>"     (the produced output to grade)
 *   --threshold <0..1>    (pass bar; default 0.7)
 *   DEMO_SCENARIO=revise  (offline only) — fake a LOW score so the REVISE branch runs.
 *
 * Why OFFLINE fakes the gateway HTTP instead of using a capability stub: the judge
 * is a raw gateway call — there is no `ctx.sapiom.llm` capability YET, so there is
 * nothing for `runLocal`'s capability stub to intercept. We monkeypatch
 * `globalThis.fetch` to return a canned judge reply, then let `runLocal` (the
 * engine simulator) walk the same step bodies. When the `llm` capability lands,
 * this becomes an ordinary `runLocal` + capability stub, like the memory example.
 *
 * The third way the SAME `index.ts` runs — Sapiom execution inside a Blaxel
 * sandbox — needs no code here; see the README RUN MODE 3.
 */
import { buildManifest } from "@sapiom/orchestration";
import { runLocal, type StubFile } from "@sapiom/orchestration-core";

import { evalGate, type EvalGateInput } from "./index.js";

// ---------------------------------------------------------------------------
// argv / env
// ---------------------------------------------------------------------------

interface Args {
  mode: "offline" | "live";
  rubric: string;
  output: string;
  input: string;
  threshold: number;
}

function parseArgs(argv: string[]): Args {
  let mode: "offline" | "live" = "offline";
  let rubric =
    "Concise (<= 12 words), mentions privacy, no jargon, reads naturally.";
  let output = "Inbox peace, finally — email that never reads your mail.";
  let input = "Write a one-line product tagline for a privacy-first email app.";
  let threshold = 0.7;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") mode = argv[++i] === "live" ? "live" : "offline";
    else if (a === "--rubric") rubric = argv[++i] ?? rubric;
    else if (a === "--output") output = argv[++i] ?? output;
    else if (a === "--input") input = argv[++i] ?? input;
    else if (a === "--threshold") threshold = Number(argv[++i] ?? threshold);
  }
  return { mode, rubric, output, input, threshold };
}

// ---------------------------------------------------------------------------
// The single run path — both modes drive the SAME step bodies via runLocal.
// ---------------------------------------------------------------------------

async function runOnce(args: Args): Promise<void> {
  // The build phase produces this manifest in production; we build it inline.
  const manifest = buildManifest(evalGate, {
    sdkVersion: "0.0.0-example",
    artifact: { sha256: "example", entryFile: "index.ts" },
  });

  // The eval-gate makes NO `ctx.sapiom.*` capability call (the judge is a raw
  // gateway call), so there is nothing to stub — an empty stub file is correct.
  const stubs: StubFile = { version: 1, steps: {} };

  const input: EvalGateInput = {
    input: args.input,
    output: args.output,
    rubric: args.rubric,
    threshold: args.threshold,
  };

  const result = await runLocal({
    definition: evalGate,
    manifest,
    input,
    stubs,
  });

  console.log(`\nworkflow "${evalGate.name}" → ${result.outcome}\n`);
  for (const step of result.steps) {
    console.log(`▶ ${step.step} (${step.status})`);
    for (const entry of step.logs) {
      const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
      console.log(`    · ${entry.msg}${meta}`);
    }
  }
  console.log(`\nfinal output: ${JSON.stringify(result.output, null, 2)}`);
}

// ---------------------------------------------------------------------------
// OFFLINE — fake the gateway HTTP so the run is offline + free.
// ---------------------------------------------------------------------------

/** Replace `globalThis.fetch` with a canned `/v1/messages` judge reply. */
function installFetchMock(score: number): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const text = JSON.stringify({
      score,
      rationale: "offline stub: canned judge reply",
    });
    const body = { content: [{ type: "text", text }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function runOffline(args: Args): Promise<void> {
  // `callJudge` guards on these; dummy values are fine since fetch is mocked.
  process.env.LLM_GATEWAY_BASE_URL ??= "http://stub.local";
  process.env.LLM_GATEWAY_API_KEY ??= "stub-key";

  const takeReviseBranch = process.env.DEMO_SCENARIO === "revise";
  const score = takeReviseBranch ? 0.4 : 0.9;
  console.log(
    `\n=== OFFLINE MODE — scenario: ${takeReviseBranch ? "revise (low score)" : "publish (high score)"} ` +
      `(faked judge score ${score}, threshold ${args.threshold}) ===`,
  );

  const restore = installFetchMock(score);
  try {
    await runOnce(args);
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// LIVE — real Sapiom LLM gateway (the judge call is real + metered).
// ---------------------------------------------------------------------------

function assertLiveEnv(): void {
  if (!process.env.LLM_GATEWAY_BASE_URL || !process.env.LLM_GATEWAY_API_KEY) {
    throw new Error(
      "LIVE mode requires LLM_GATEWAY_BASE_URL + LLM_GATEWAY_API_KEY (the Sapiom LLM gateway). " +
        "Optionally set LLM_GATEWAY_MODEL (default: claude-sonnet-4-6).",
    );
  }
}

async function runLive(args: Args): Promise<void> {
  assertLiveEnv();
  console.log(
    `\n=== LIVE MODE — judging against ${process.env.LLM_GATEWAY_BASE_URL} (threshold ${args.threshold}) ===`,
  );
  await runOnce(args);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "live") {
    await runLive(args);
  } else {
    await runOffline(args);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
