import {
  defineOrchestration,
  defineStep,
  goto,
  terminate,
  fail,
  pauseUntilSignal,
} from "@sapiom/orchestration";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";

/**
 * __PROJECT_NAME__ — a human-in-the-loop coding-agent workflow that gates the
 * **publish to `main`** behind an explicit human approval.
 *
 *   prepare → propose ──pause(agent.coding.result)──▶ review
 *      review ──pause(review.decision)──▶ decide
 *          decide ──reject──▶ terminate (main untouched)
 *          decide ──approve──pause(agent.coding.result)──▶ finalize
 *
 * Why two agents. The gating action must be the *publish to the canonical branch*,
 * and it must run **only after** a human approves. A single coding run can't give
 * us that: the agent clones, edits, commits and pushes inside its own run — before
 * any pause — so by the time a human sees the work it has already landed, and a
 * "reject" would be reverting code that's already on `main`. This template splits
 * the two irreversible actions across two runs so the gate sits *upstream* of the
 * one that touches `main`:
 *
 *   - `propose` launches agent #1 to write the change and push it to a
 *     **non-canonical** `proposed/<executionId>` branch. `main` is never touched.
 *   - the workflow pauses for a human decision (`review.decision`).
 *   - on **approve**, `decide` launches agent #2 to promote `proposed/…` onto
 *     `main`. This is the ONLY step that writes `main`, and it runs only after the
 *     approve signal.
 *   - on **reject** (or no explicit approval), the workflow terminates and `main`
 *     is left exactly as it was.
 *
 * Pause/resume mechanics: a resumed step's `input` IS the signal payload. For a
 * coding run that's a `CodingResultPayload`; for the human decision it's whatever
 * the caller sent when firing `review.decision`. Payloads cross a wire boundary,
 * so they carry no live handles — re-attach the repo from `ctx.shared` before
 * launching the next agent.
 */

const REPO_SLUG = "__PROJECT_NAME__-notes";

/** The signal a human fires to approve or reject the proposed change. */
const REVIEW_SIGNAL = "review.decision";

/**
 * Payload a caller sends when firing {@link REVIEW_SIGNAL}. Publishing to `main`
 * requires `decision === "approved"` — anything else (including an absent
 * decision) leaves `main` unchanged.
 */
interface ReviewDecision {
  decision?: "approved" | "rejected";
  note?: string;
}

interface Shared extends Record<string, unknown> {
  slug: string;
  cloneUrl: string;
  /** The non-canonical branch agent #1 pushes to and agent #2 promotes from. */
  branch: string;
}

/** Find the repo (or create it on the first run) and pick the proposal branch. */
const prepare = defineStep({
  name: "prepare",
  next: ["propose"],
  async run(_input, ctx) {
    const existing = await ctx.sapiom.repositories.list();
    const repo =
      existing.find((r) => r.slug === REPO_SLUG) ??
      (await ctx.sapiom.repositories.create(REPO_SLUG));
    ctx.shared.set("slug", repo.slug);
    ctx.shared.set("cloneUrl", repo.cloneUrl);
    // Deterministic + unique per execution, so re-runs don't collide on the repo.
    ctx.shared.set("branch", `proposed/${ctx.executionId}`);
    return goto("propose", {});
  },
});

/**
 * Launch agent #1 to write the change onto the proposal branch — NOT `main` — and
 * suspend until it finishes. Nothing lands on `main` here.
 */
const propose = defineStep({
  name: "propose",
  next: [],
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "review" },
  async run(_input, ctx) {
    const repo = ctx.sapiom.repositories.attach(
      ctx.shared.get("slug") as string,
      ctx.shared.get("cloneUrl") as string,
    );
    const branch = ctx.shared.get("branch") as string;
    const run = await ctx.sapiom.agent.coding.launch({
      task: [
        "You are in a git checkout of this repository.",
        `1. Create and switch to a new branch named exactly "${branch}". Do NOT work on "main".`,
        `2. Make a small, self-contained change and commit it on "${branch}".`,
        `3. Push the branch to origin: git push -u origin "${branch}".`,
        'Do NOT push to, merge into, or otherwise modify "main".',
      ].join("\n"),
      gitRepository: repo, // auto-cloned into the sandbox at /workspace/<slug>
    });
    ctx.logger.info("proposal agent launched; suspending until it finishes", {
      runId: run.runId,
      branch,
    });
    return pauseUntilSignal(run, { resumeStep: "review" });
  },
});

/**
 * Resumed once agent #1 finishes. The change now lives only on the proposal
 * branch — `main` is untouched. Pause for a human decision.
 */
const review = defineStep({
  name: "review",
  next: [],
  canFail: true,
  pause: { signal: REVIEW_SIGNAL, resumeStep: "decide" },
  async run(proposal: CodingResultPayload, ctx) {
    if (proposal.status !== "completed" || !proposal.result?.success) {
      return fail(
        `proposal agent did not succeed: ${proposal.error?.message ?? proposal.status}`,
      );
    }
    ctx.logger.info(
      "proposal pushed to review branch; awaiting human approval",
      {
        branch: ctx.shared.get("branch") as string,
        runId: proposal.runId,
      },
    );
    // Suspend until a human fires `review.decision`. Publishing to `main` happens
    // only in `decide`'s approve path below — so a reject (or a stalled review)
    // never lands anything on the canonical branch.
    return pauseUntilSignal({ signal: REVIEW_SIGNAL, resumeStep: "decide" });
  },
});

/**
 * Resumed with the human decision. On reject, terminate with `main` untouched. On
 * approve, launch agent #2 to promote the proposal branch onto `main` — the only
 * step that writes the canonical branch, reached only after an approve.
 */
const decide = defineStep({
  name: "decide",
  next: [],
  terminal: true,
  canFail: true,
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "finalize" },
  async run(decision: ReviewDecision, ctx) {
    const branch = ctx.shared.get("branch") as string;
    if (decision?.decision !== "approved") {
      ctx.logger.info("review rejected; leaving main unchanged", {
        branch,
        decision: decision?.decision ?? null,
      });
      return terminate(
        { decision: "rejected", published: false, branch },
        { reason: "rejected" },
      );
    }
    const repo = ctx.sapiom.repositories.attach(
      ctx.shared.get("slug") as string,
      ctx.shared.get("cloneUrl") as string,
    );
    const run = await ctx.sapiom.agent.coding.launch({
      task: [
        "A human approved publishing the proposed change to the canonical branch.",
        "1. Fetch the latest refs: git fetch origin.",
        '2. Check out "main" and make sure it matches origin/main.',
        `3. Merge "origin/${branch}" into "main" (fast-forward when possible).`,
        "4. Push the result: git push origin main.",
      ].join("\n"),
      gitRepository: repo,
    });
    ctx.logger.info("review approved; promote agent launched", {
      runId: run.runId,
      branch,
    });
    return pauseUntilSignal(run, { resumeStep: "finalize" });
  },
});

/** Resumed once agent #2 finishes. The change is now on `main`. */
const finalize = defineStep({
  name: "finalize",
  next: [],
  terminal: true,
  canFail: true,
  async run(promotion: CodingResultPayload, ctx) {
    if (promotion.status !== "completed" || !promotion.result?.success) {
      return fail(
        `promote agent did not succeed: ${promotion.error?.message ?? promotion.status}`,
      );
    }
    return terminate({
      decision: "approved",
      published: true,
      branch: ctx.shared.get("branch") as string,
      runId: promotion.runId,
      summary: promotion.summary,
    });
  },
});

export const orchestration = defineOrchestration<unknown, Shared>({
  name: "__PROJECT_NAME__",
  entry: "prepare",
  steps: { prepare, propose, review, decide, finalize },
});
