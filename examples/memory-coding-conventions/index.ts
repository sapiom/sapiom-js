/**
 * Sapiom workflow example — "the coding agent forgets house conventions."
 *
 * A coding agent has no memory between runs: left alone it re-derives (or
 * violates) your team's house style every single time. This workflow fixes that
 * with the `memory` capability:
 *
 *   recall ─▶ code ─▶ learn
 *
 *   1. recall  — pull the house conventions learned on PRIOR runs and INJECT them
 *                into the agent's task prompt (recall → inject).
 *   2. code    — run the coding agent with that convention-enriched task.
 *   3. learn   — APPEND a new, hard-won fact back to memory, so the NEXT run
 *                recalls it and the agent never "forgets" it again.
 *
 * This file is a teaching artifact: it mocks the engine + gateway with
 * `runLocal` + stub capabilities (no network, no credentials, no Sapiom
 * account), then prints the per-step trace so you can watch recall → inject →
 * append happen. See the README for how the mock maps onto production.
 */
import {
  defineOrchestration,
  defineStep,
  goto,
  terminate,
  fail,
  buildManifest,
} from "@sapiom/orchestration";
import { runLocal, type StubFile } from "@sapiom/orchestration-core";

/** What the workflow is kicked off with. */
interface WorkflowInput {
  /** The repo the agent will work in — also the memory partition for its conventions. */
  repoSlug: string;
  /** The feature request, before any house conventions are layered on. */
  baseTask: string;
}

/** Run-scoped values stashed in `ctx.shared` so later steps can read them. */
interface Shared extends Record<string, unknown> {
  repoSlug: string;
}

/** The memory scope this repo's conventions live under. */
const CONVENTIONS_SCOPE = "house-conventions";

// ---------------------------------------------------------------------------
// Step 1 — recall the conventions and inject them into the task (recall→inject)
// ---------------------------------------------------------------------------

const recall = defineStep({
  name: "recall",
  next: ["code"],
  async run(input: WorkflowInput, ctx) {
    ctx.shared.set("repoSlug", input.repoSlug);

    // RECALL: hybrid (vector + full-text) search over what we learned before.
    const { results } = await ctx.sapiom.memory.recall({
      query: `coding conventions and house style for the ${input.repoSlug} repo`,
      scope: CONVENTIONS_SCOPE,
      topK: 10,
    });
    ctx.logger.info(`recalled ${results.length} house convention(s)`, {
      conventions: results.map((m) => m.content),
    });

    // INJECT: fold the recalled facts into the agent's task prompt. The agent
    // has no memory of its own — this is the only thing standing between it and
    // re-litigating your house style from scratch.
    const enrichedTask =
      results.length === 0
        ? input.baseTask
        : [
            input.baseTask,
            "",
            `Follow these house conventions (recalled from prior runs in the ${input.repoSlug} repo):`,
            ...results.map((m) => `- ${m.content}`),
          ].join("\n");

    ctx.logger.info("injected recalled conventions into the coding task");
    return goto("code", { task: enrichedTask });
  },
});

// ---------------------------------------------------------------------------
// Step 2 — run the coding agent with the convention-enriched task
// ---------------------------------------------------------------------------

const code = defineStep({
  name: "code",
  next: ["learn"],
  async run(input: { task: string }, ctx) {
    // We `run` (await inline) for a readable, top-to-bottom teaching trace. A
    // production workflow with a long-running agent would instead `launch` +
    // `pauseUntilSignal` so a long run holds no worker — see the `coding-pause`
    // template. The memory pattern is identical either way.
    const run = await ctx.sapiom.agent.coding.run({ task: input.task });
    ctx.logger.info("coding agent finished", {
      status: run.status,
      summary: run.summary,
    });
    return goto("learn", {
      success: run.result?.success ?? false,
      summary: run.summary,
    });
  },
});

// ---------------------------------------------------------------------------
// Step 3 — append a new learning so the next run starts smarter (append)
// ---------------------------------------------------------------------------

const learn = defineStep({
  name: "learn",
  next: [],
  terminal: true,
  canFail: true,
  async run(input: { success: boolean; summary: string | null }, ctx) {
    if (!input.success) {
      return fail(`coding agent did not succeed: ${input.summary ?? "unknown"}`);
    }
    const repoSlug = ctx.shared.get("repoSlug") as string;

    // APPEND: record a durable, repo-specific fact this run surfaced — exactly
    // the kind of gotcha the agent would otherwise forget by next time. On the
    // next run, `recall` returns this and `code` injects it automatically.
    const appended = await ctx.sapiom.memory.append({
      content:
        `When adding an HTTP endpoint to the ${repoSlug} repo, also register it in ` +
        `src/routes/index.ts — the router does not auto-discover handlers.`,
      scope: CONVENTIONS_SCOPE,
      metadata: { repo: repoSlug, source: "coding-run" },
    });
    ctx.logger.info("appended a new house-convention learning", {
      memoryId: appended.id,
      decision: appended.decision,
    });

    return terminate({
      learningId: appended.id,
      decision: appended.decision,
      summary: input.summary,
    });
  },
});

/** The workflow. In production the engine imports this `orchestration` export. */
export const orchestration = defineOrchestration<WorkflowInput, Shared>({
  name: "memory-coding-conventions",
  entry: "recall",
  steps: { recall, code, learn },
});

// ===========================================================================
// Local run — mocks the engine (`runLocal`) and the gateway (stub capabilities)
// ===========================================================================

async function main(): Promise<void> {
  // The build phase produces this manifest in production; we build it inline.
  const manifest = buildManifest(orchestration, {
    sdkVersion: "0.0.0-example",
    artifact: { sha256: "example", entryFile: "index.ts" },
  });

  // Stub the gateway. The golden rule (same as `.sapiom-dev/stubs.json`): only
  // stub what a step BRANCHES ON. `recall`'s results get injected, and `code`'s
  // success gates the `learn` step — so both are stubbed. `memory.append` is
  // fire-and-record (nothing branches on its result), so it's left to the
  // built-in default.
  const stubs: StubFile = {
    version: 1,
    steps: {
      recall: {
        "memory.recall": {
          results: [
            {
              id: "m1",
              content:
                "Validate every request body with a zod schema before using it.",
              scope: CONVENTIONS_SCOPE,
              vectorScore: 0.9,
              textScore: 0.5,
              combinedScore: 0.82,
              status: "active",
              createdAt: "2026-06-01T00:00:00Z",
              metadata: {},
            },
            {
              id: "m2",
              content:
                "Use named exports only — no default exports anywhere in this codebase.",
              scope: CONVENTIONS_SCOPE,
              vectorScore: 0.88,
              textScore: 0.4,
              combinedScore: 0.79,
              status: "active",
              createdAt: "2026-06-02T00:00:00Z",
              metadata: {},
            },
            {
              id: "m3",
              content:
                "Commit messages must follow Conventional Commits (e.g. 'feat: ...').",
              scope: CONVENTIONS_SCOPE,
              vectorScore: 0.85,
              textScore: 0.45,
              combinedScore: 0.77,
              status: "active",
              createdAt: "2026-06-03T00:00:00Z",
              metadata: {},
            },
          ],
          query: "coding conventions and house style for the api repo",
          topK: 10,
          count: 3,
        },
      },
      code: {
        "agent.coding.run": {
          runId: "run-stub-1",
          status: "completed",
          summary:
            "Added POST /users with zod validation and a named export; committed as 'feat: add user creation endpoint'.",
          result: {
            success: true,
            turns: 4,
            modelUsed: "stub-model",
            durationMs: 1234,
            toolCallCount: 7,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
              thinkingTokens: 0,
            },
          },
          error: null,
        },
      },
    },
  };

  const result = await runLocal({
    definition: orchestration,
    manifest,
    input: {
      repoSlug: "api",
      baseTask: "Add a POST /users endpoint that creates a user.",
    } satisfies WorkflowInput,
    stubs,
  });

  // ----- print the trace so you can watch recall → inject → append -----
  console.log(`\n=== workflow "${orchestration.name}" → ${result.outcome} ===\n`);
  for (const step of result.steps) {
    console.log(`▶ ${step.step} (${step.status})`);
    for (const entry of step.logs) {
      const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : "";
      console.log(`    · ${entry.msg}${meta}`);
    }
  }
  console.log(`\nfinal output: ${JSON.stringify(result.output, null, 2)}`);
  if (result.unusedStubs.length > 0) {
    console.log(`\nunused stubs:`, result.unusedStubs);
  }
  if (result.stubWarnings.length > 0) {
    console.log(`\nstub warnings:`, result.stubWarnings);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
