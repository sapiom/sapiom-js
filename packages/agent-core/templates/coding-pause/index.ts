import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  fail,
  pauseUntilSignal,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";

/**
 * __PROJECT_NAME__ — a non-blocking coding-agent workflow.
 *
 *   prepare → kickoff ──pause(models.coding.result)──▶ finalize
 *
 * `kickoff` *launches* the coding agent (fire-and-forget) and returns
 * `pauseUntilSignal(handle, …)`, suspending the workflow on the run's result
 * signal — so a long run holds no worker. When the run reaches a terminal state
 * the engine resumes `finalize` with the run result as its input.
 *
 * Key idea: the resumed step's `input` IS the signal payload (typed here as
 * `CodingResultPayload`). It crossed a wire boundary, so there are no live
 * handles — re-attach the run's sandbox from `executionEnvironment` with
 * `ctx.sapiom.sandboxes.attach(executionEnvironment.id)`. Anything else the
 * resumed step needs is stashed in `ctx.shared` before pausing.
 */

const REPO_SLUG = "__PROJECT_NAME__-notes";

interface Shared extends Record<string, unknown> {
  slug: string;
  cloneUrl: string;
}

/** Find the repo, or create it on the first run. */
const prepare = defineStep({
  name: "prepare",
  next: ["kickoff"],
  async run(_input, ctx) {
    const existing = await ctx.sapiom.repositories.list();
    const repo =
      existing.find((r) => r.slug === REPO_SLUG) ??
      (await ctx.sapiom.repositories.create(REPO_SLUG));
    ctx.shared.set("slug", repo.slug);
    ctx.shared.set("cloneUrl", repo.cloneUrl);
    return goto("kickoff", {});
  },
});

/** Launch the agent and suspend until it finishes — do NOT await the run. */
const kickoff = defineStep({
  name: "kickoff",
  next: [],
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "finalize" },
  async run(_input, ctx) {
    const repo = ctx.sapiom.repositories.attach(
      ctx.shared.get("slug") as string,
      ctx.shared.get("cloneUrl") as string,
    );
    const run = await ctx.sapiom.models.coding.launch({
      task: "Make a small, self-contained change to this repository and commit it.",
      gitRepository: repo, // auto-cloned into the sandbox at /workspace/<slug>
    });
    ctx.logger.info("agent launched; suspending until it finishes", {
      runId: run.runId,
    });
    return pauseUntilSignal(run, { resumeStep: "finalize" });
  },
});

/** Resumed once the run is done. The `input` is the coding result payload. */
const finalize = defineStep({
  name: "finalize",
  next: [],
  terminal: true,
  canFail: true,
  async run(run: CodingResultPayload, ctx) {
    if (run.status !== "completed" || !run.result?.success) {
      return fail(
        `coding agent did not succeed: ${run.error?.message ?? run.status}`,
      );
    }
    // Re-attach live handles from plain values, then publish the agent's work.
    const repo = ctx.sapiom.repositories.attach(
      ctx.shared.get("slug") as string,
      ctx.shared.get("cloneUrl") as string,
    );
    const env = run.executionEnvironment;
    if (!env) {
      return fail("coding run did not provision an execution environment");
    }
    const sandbox = ctx.sapiom.sandboxes.attach(env.id);
    const push = await repo.pushFromSandbox(sandbox, {
      message: "chore: automated change",
    });
    return terminate({
      runId: run.runId,
      pushed: push.pushed,
      sha: push.sha,
      summary: run.summary,
    });
  },
});

export const orchestration = defineAgent<unknown, Shared>({
  name: "__PROJECT_NAME__",
  entry: "prepare",
  steps: { prepare, kickoff, finalize },
});
