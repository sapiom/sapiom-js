/**
 * memory-coding-conventions-WORKFLOW
 * ----------------------------------
 * The workflow (orchestration) version of the memory demo. Same recall → apply →
 * learn → verify memory loop as the two siblings, but authored as a DEPLOYABLE
 * Sapiom orchestration that runs THREE ways without a single code change:
 *
 *   1. stub-local  — `runLocal` + canned stubs, offline + free (see run-local.ts).
 *   2. live-local  — a dev walker drives these same step bodies against the REAL
 *                    local memory gateway (see run-local.ts `--mode live`).
 *   3. Sapiom execution — the engine imports THIS file, bundles it, and walks the
 *                    identical step bodies inside a Blaxel sandbox (see README).
 *
 * Contrast with the siblings:
 *   - ../memory-coding-conventions       — stub-only teaching artifact; its
 *     `runLocal` call lives INSIDE index.ts (so index.ts is not deployable).
 *   - ../memory-coding-conventions-live  — a bare `main()` against the live
 *     gateway; not a workflow at all (no steps, no engine, no deploy path).
 *
 * THIS file is the DEPLOYABLE ARTIFACT and is therefore SIDE-EFFECT-FREE: it only
 * defines steps and exports exactly ONE `defineOrchestration`. There is no
 * `main()`, no `runLocal` call, no top-level execution — so the engine can import
 * and bundle it cleanly. The harness that runs it lives in `run-local.ts`.
 *
 * Step graph:
 *
 *   recall ─▶ apply ─┬─▶ learn ─▶ verify   (a new convention was recorded)
 *                    └─▶ skip            (the convention was already known)
 */
import { defineStep, defineOrchestration, goto, terminate } from "@sapiom/orchestration";
// The memory capability's types are published under the `memory` namespace export
// of @sapiom/tools (`export * as memory`), so we reference them as `memory.*`.
import type { memory } from "@sapiom/tools";
import { z } from "zod/v4";

type RecallMatch = memory.RecallMatch;
type AppendResult = memory.AppendResult;
type Memory = memory.Memory;

/** What the workflow is kicked off with. */
export interface WorkflowInput {
  /** The repo the agent works in — also the memory partition for its conventions. */
  repoSlug: string;
  /** The feature request, before any house conventions are layered on. */
  task: string;
}

/** Run-scoped values stashed in `ctx.shared` so later steps can read them. */
export interface Shared extends Record<string, unknown> {
  repoSlug: string;
}

/** The memory scope this workflow's conventions live under. */
const SCOPE = "house-conventions";

// ---------------------------------------------------------------------------
// Step 1 — recall the conventions and inject them into the task (recall→inject)
// ---------------------------------------------------------------------------

const recall = defineStep({
  name: "recall",
  next: ["apply"],
  inputSchema: z.object({
    repoSlug: z.string(),
    task: z.string(),
  }),
  async run(input: WorkflowInput, ctx) {
    // Stash the repo so the audit trail (and any downstream step) can read it.
    ctx.shared.set("repoSlug", input.repoSlug);

    // RECALL: hybrid (vector + full-text) search over what we learned before.
    const { results, count } = await ctx.sapiom.memory.recall({
      query: input.task,
      scope: SCOPE,
      topK: 5,
    });
    ctx.logger.info("recalled", { count });

    // INJECT: fold the recalled facts into the agent's task prompt as a numbered
    // "House conventions" preamble. A stateless agent has no memory of its own —
    // this preamble is the only thing carrying prior knowledge into its context.
    const preamble =
      count === 0
        ? ""
        : [
            "",
            `Follow these house conventions (recalled from prior runs in the ${input.repoSlug} repo):`,
            ...results.map((m, i) => `  ${i + 1}. ${m.content}`),
          ].join("\n");
    const enrichedTask = `${input.task}${preamble}`;

    // `topMatch` is the best prior memory (or null). `apply` branches on it.
    const topMatch: RecallMatch | null = results[0] ?? null;
    return goto("apply", { enrichedTask, priorCount: count, topMatch });
  },
});

// ---------------------------------------------------------------------------
// Step 2 — decide the new convention, and branch on whether it's already known
// ---------------------------------------------------------------------------

interface ApplyInput {
  enrichedTask: string;
  priorCount: number;
  topMatch: RecallMatch | null;
}

const apply = defineStep({
  name: "apply",
  next: ["learn", "skip"],
  async run(input: ApplyInput, ctx) {
    // PURE LOGIC — no capability call here, so this step has nothing to stub.
    // (In a fuller demo a coding agent would run against `input.enrichedTask`
    //  here; we keep `apply` deterministic so stubs can drive BOTH branches.)

    // Derive a one-line convention from the task, deterministically. This stands
    // in for "the durable, repo-specific fact this run surfaced" that we want the
    // NEXT run to recall automatically.
    const repoSlug = ctx.shared.get("repoSlug") ?? "this";
    const convention = `When working on "${input.enrichedTask.split("\n")[0]}" in the ${repoSlug} repo, follow the recalled house conventions before writing new code.`;

    // BRANCH — the real decision the whole demo turns on:
    //   Is this convention ALREADY recorded? The heuristic is intentionally
    //   simple and well-commented so a stub can flip it either way:
    //     - we have a prior match (topMatch present, priorCount > 0), AND
    //     - that prior match's combined score is high enough that we treat it as
    //       "already covers this task" (>= 0.8 — the same cosine threshold the
    //       gateway uses to supersede a near-duplicate on append).
    //   When both hold we SKIP the write (nothing new to learn); otherwise we LEARN.
    const alreadyKnown =
      input.topMatch !== null &&
      input.priorCount > 0 &&
      input.topMatch.combinedScore >= 0.8;

    if (alreadyKnown) {
      ctx.logger.info("convention already recorded — skipping the write");
      return goto("skip", {
        reason: "convention already recorded",
        matched: input.topMatch,
      });
    }

    ctx.logger.info("new convention to record", { convention });
    return goto("learn", { convention });
  },
});

// ---------------------------------------------------------------------------
// Step 3 — append the new learning so the next run starts smarter (append)
// ---------------------------------------------------------------------------

interface LearnInput {
  convention: string;
}

const learn = defineStep({
  name: "learn",
  next: ["verify"],
  // `canFail: true` lets this step return `fail(...)` on a KNOWN-TERMINAL
  // condition (e.g. the gateway reports the write was rejected). We don't do that
  // here, but declaring it documents the seam. THROWING is reserved for
  // UNEXPECTED/transient errors (a network blip) — those hit the engine's
  // retry-up-to-cap self-heal path. Picking `fail()` vs throw is the difference
  // between "diagnosed, don't retry" and "might be transient, do retry".
  canFail: true,
  async run(input: LearnInput, ctx) {
    // APPEND: record the durable, repo-specific fact this run surfaced. On the
    // next run, `recall` returns this and `apply` folds it into the task prompt.
    const res: AppendResult = await ctx.sapiom.memory.append({
      content: input.convention,
      scope: SCOPE,
      metadata: { source: "memory-coding-conventions-workflow" },
    });
    ctx.logger.info("appended", { id: res.id, decision: res.decision });

    return goto("verify", {
      id: res.id,
      decision: res.decision,
      supersededId: res.supersededId,
      similarityScore: res.similarityScore,
    });
  },
});

// ---------------------------------------------------------------------------
// Step 4 — read the memory back to prove it persisted (terminal)
// ---------------------------------------------------------------------------

interface VerifyInput {
  id: string;
  decision: AppendResult["decision"];
  supersededId: string | null;
  similarityScore: number | null;
}

const verify = defineStep({
  name: "verify",
  terminal: true,
  async run(input: VerifyInput, ctx) {
    // GET is free for identified callers — read the row back to confirm it stuck.
    const mem: Memory = await ctx.sapiom.memory.get(input.id);
    ctx.logger.info("verified", { id: mem.id, status: mem.status });

    return terminate(
      {
        id: mem.id,
        decision: input.decision,
        status: mem.status,
        scope: mem.scope,
      },
      { reason: "convention persisted" },
    );
  },
});

// ---------------------------------------------------------------------------
// Step 4' — the skip branch: nothing new to record (terminal)
// ---------------------------------------------------------------------------

interface SkipInput {
  reason: string;
  matched: RecallMatch | null;
}

const skip = defineStep({
  name: "skip",
  terminal: true,
  async run(input: SkipInput, ctx) {
    ctx.logger.info("skipped the write", { reason: input.reason });
    return terminate({ skipped: true, reason: input.reason });
  },
});

/**
 * The workflow. In production the engine imports THIS `orchestration` export,
 * bundles it, and walks these step bodies inside a Blaxel sandbox.
 *
 * Exactly ONE `defineOrchestration` is exported from this module — the
 * orchestration-core loader requires precisely one.
 */
export const orchestration = defineOrchestration<WorkflowInput, Shared>({
  name: "memory-coding-conventions-workflow",
  entry: "recall",
  steps: { recall, apply, learn, verify, skip },
});
