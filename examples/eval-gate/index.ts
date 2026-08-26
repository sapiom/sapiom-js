import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

import { buildDraftPrompt } from "./draft.js";
import { buildJudgePrompt, parseScore } from "./judge.js";

/**
 * Self-Editing Writer
 * -------------------
 * Give it a brief and a rubric; it drafts, critiques its own draft against the
 * rubric with an LLM judge, and revises — bounded — until the draft clears the
 * bar or the attempt cap is hit, then publishes whichever draft that was:
 *
 *   parse ─▶ draft ─▶ judge ─▶ decide ─┬─▶ draft   (score < threshold, attempts remain — loop)
 *                        (loop back)   └─▶ publish (score >= threshold, OR attempts exhausted)
 *
 * `draft` and `judge` are both ordinary `llm.run` calls — the judge reads
 * the draft `draft` just wrote, so this is chained judgment: the second
 * model's input is the first model's output, and drift can compound across a
 * revision. `decide` is pure branch logic, no model call: it either loops
 * back to `draft` with the rejected attempt and the judge's critique so far,
 * or terminates at `publish` with the best draft produced. The loop is
 * bounded by `maxIterations` (default 2 draft attempts) so it always
 * terminates — `decide` never loops past that cap, pass or not.
 *
 * `publish` is honest either way: it always returns the final draft, but
 * `passed` says whether it actually cleared the rubric or the run simply ran
 * out of attempts. There's no separate "reject" outcome — a self-editing
 * writer with nowhere to send a failing draft still has to hand back
 * something, so it hands back its best attempt and says so.
 */

/** Run-scoped values threaded through the loop via `ctx.shared`. */
interface WriterShared extends Record<string, unknown> {
  brief: string;
  rubric: string;
  threshold: number;
  maxIterations: number;
  /** The attempt number the run is currently drafting (1-based). */
  iteration: number;
  model?: string;
  judgeModel?: string;
  /** The rejected draft `decide` sends back for `draft` to revise. */
  previousDraft?: string;
  /** The judge's critique of `previousDraft`, addressed by the revision. */
  critique?: string;
  /** Set when the run used the built-in sample brief/rubric. */
  note?: string;
}

/**
 * The sample brief + rubric a zero-input run drafts and grades for real. Concrete
 * enough that the draft is a real artifact and the rubric has teeth — a model
 * that pads past the word count or reaches for a cliché genuinely fails it.
 */
const SAMPLE_BRIEF =
  "Write a 3-5 sentence noir-style opening for a detective agency called Northstar Investigations.";
const SAMPLE_RUBRIC =
  "Under 120 words. Noir tone: short, punchy sentences, understated menace. Establishes a hook — a case or a client. No clichés like 'dark and stormy night'. No meta-commentary, just the paragraph.";
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_MAX_ITERATIONS = 2;

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
}

const entryInputSchema = z
  .object({
    brief: z
      .string()
      .min(1)
      .default(SAMPLE_BRIEF)
      .describe("What to write. Fed to the draft step's prompt."),
    rubric: z
      .string()
      .min(1)
      .default(SAMPLE_RUBRIC)
      .describe(
        "YOUR pass/fail criteria. The judge scores every draft against this — we ship no scorer taxonomy.",
      ),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_THRESHOLD)
      .describe("Pass bar in [0,1]. score >= threshold publishes immediately."),
    maxIterations: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(DEFAULT_MAX_ITERATIONS)
      .describe(
        "Bound on draft attempts (1 initial + revisions). The run always publishes by this attempt, pass or not.",
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Optional routing label for the draft call. Omit it to use the platform default.",
      ),
    judgeModel: z
      .string()
      .optional()
      .describe(
        "Optional routing label for the judge call. Omit it to use the platform default.",
      ),
  })
  .meta({
    examples: [
      {
        brief: SAMPLE_BRIEF,
        rubric: SAMPLE_RUBRIC,
        threshold: DEFAULT_THRESHOLD,
        maxIterations: DEFAULT_MAX_ITERATIONS,
      },
    ],
  });

/** What the agent run starts with. */
export type WriterInput = z.infer<typeof entryInputSchema>;

// ---------------------------------------------------------------------------
// Step 1 — parse: validate + default the brief/rubric, seed the loop state.
// ---------------------------------------------------------------------------

const parse = defineStep({
  name: "parse",
  next: ["draft"],
  inputSchema: entryInputSchema,
  async run(input: WriterInput, ctx: AgentExecutionContext<WriterShared>) {
    ctx.shared.set("brief", input.brief);
    ctx.shared.set("rubric", input.rubric);
    ctx.shared.set("threshold", input.threshold);
    ctx.shared.set("maxIterations", input.maxIterations);
    ctx.shared.set("iteration", 1);
    if (input.model) ctx.shared.set("model", input.model);
    if (input.judgeModel) ctx.shared.set("judgeModel", input.judgeModel);
    if (input.brief === SAMPLE_BRIEF && input.rubric === SAMPLE_RUBRIC) {
      // Say so in the artifact: a real self-edit against OUR sample brief is
      // not a self-edit against yours.
      ctx.shared.set(
        "note",
        "Drafted and judged the built-in sample brief/rubric. Pass your own `brief` and `rubric` to write and grade yours.",
      );
    }
    ctx.logger.info("parse: starting the self-editing loop", {
      threshold: input.threshold,
      maxIterations: input.maxIterations,
    });
    return goto("draft", {});
  },
});

// ---------------------------------------------------------------------------
// Step 2 — draft: write (or revise) the piece. One llm.run call.
// ---------------------------------------------------------------------------

const draft = defineStep({
  name: "draft",
  next: ["judge"],
  timeoutMs: 60_000,
  async run(_input: unknown, ctx: AgentExecutionContext<WriterShared>) {
    const brief = must(ctx.shared.get("brief"), "brief");
    const rubric = must(ctx.shared.get("rubric"), "rubric");
    const iteration = must(ctx.shared.get("iteration"), "iteration");
    const previousDraft = ctx.shared.get("previousDraft");
    const critique = ctx.shared.get("critique");
    const prompt = buildDraftPrompt({
      brief,
      rubric,
      ...(previousDraft !== undefined &&
        critique !== undefined && {
          revision: { draft: previousDraft, critique },
        }),
    });
    ctx.logger.info(`draft: writing attempt ${iteration}`, { iteration });
    // The load-bearing seam: an ordinary metered LLM call. An empty reply
    // means the writer produced nothing real to grade, so we throw and let
    // the engine retry rather than judging a blank page.
    const res = await ctx.sapiom.llm.run({
      request: {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
      },
      model: ctx.shared.get("model"),
    });
    const text = (ctx.sapiom.llm.textOf(res) ?? "").trim();
    if (!text) {
      throw new Error(
        "self-editing writer: draft model returned no text to grade",
      );
    }
    return goto("judge", { draft: text });
  },
});

// ---------------------------------------------------------------------------
// Step 3 — judge: score the draft against the rubric. One llm.run call.
// ---------------------------------------------------------------------------

interface DraftPayload {
  draft: string;
}

const judge = defineStep({
  name: "judge",
  next: ["decide"],
  timeoutMs: 60_000,
  async run(input: DraftPayload, ctx: AgentExecutionContext<WriterShared>) {
    const brief = must(ctx.shared.get("brief"), "brief");
    const rubric = must(ctx.shared.get("rubric"), "rubric");
    const prompt = buildJudgePrompt({
      input: brief,
      output: input.draft,
      rubric,
    });
    // Chained judgment: this call's input is the `draft` step's model output,
    // not caller-supplied data — a malformed reply still throws in
    // `parseScore` and the engine retries, same contract as `draft`.
    const res = await ctx.sapiom.llm.run({
      request: {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
      },
      model: ctx.shared.get("judgeModel"),
    });
    const { score, rationale } = parseScore(ctx.sapiom.llm.textOf(res) ?? "");
    ctx.logger.info("judge: scored the draft against the rubric", { score });
    return goto("decide", { draft: input.draft, score, critique: rationale });
  },
});

// ---------------------------------------------------------------------------
// Step 4 — decide: the bounded loop gate. Pure logic, no model call.
// ---------------------------------------------------------------------------

interface DecideInput {
  draft: string;
  score: number;
  critique: string;
}

interface PublishInput {
  draft: string;
  score: number;
  critique: string;
  passed: boolean;
  iterations: number;
}

const decide = defineStep({
  name: "decide",
  next: ["draft", "publish"],
  async run(input: DecideInput, ctx: AgentExecutionContext<WriterShared>) {
    const threshold = must(ctx.shared.get("threshold"), "threshold");
    const maxIterations = must(
      ctx.shared.get("maxIterations"),
      "maxIterations",
    );
    const iteration = must(ctx.shared.get("iteration"), "iteration");
    const passed = input.score >= threshold;
    const exhausted = iteration >= maxIterations;

    if (passed || exhausted) {
      ctx.logger.info(
        `decide: ${passed ? "cleared the rubric" : "hit the attempt cap"} — publishing`,
        { score: input.score, threshold, iteration },
      );
      return goto("publish", {
        draft: input.draft,
        score: input.score,
        critique: input.critique,
        passed,
        iterations: iteration,
      });
    }

    // Bounded revise-loop: hand `draft` the rejected attempt and the judge's
    // critique, advance the attempt counter, and loop back. `maxIterations`
    // guarantees this always reaches `publish` — there is no unbounded path.
    ctx.shared.set("previousDraft", input.draft);
    ctx.shared.set("critique", input.critique);
    ctx.shared.set("iteration", iteration + 1);
    ctx.logger.info("decide: below threshold, revising", {
      score: input.score,
      threshold,
      nextIteration: iteration + 1,
      maxIterations,
    });
    return goto("draft", {});
  },
});

// ---------------------------------------------------------------------------
// Step 5 — publish: the one terminal. Always returns the final draft.
// ---------------------------------------------------------------------------

const publish = defineStep({
  name: "publish",
  next: [],
  terminal: true,
  async run(input: PublishInput, ctx: AgentExecutionContext<WriterShared>) {
    const threshold = must(ctx.shared.get("threshold"), "threshold");
    const note = ctx.shared.get("note");
    const capNote = !input.passed
      ? `Hit the ${input.iterations}-attempt cap without clearing the rubric (score ${input.score} < ${threshold}) — this is the best draft produced, not a passing one.`
      : undefined;
    ctx.logger.info(
      `publish: ${input.passed ? "cleared" : "did not clear"} the rubric after ${input.iterations} attempt(s)`,
      { score: input.score, threshold },
    );
    return terminate(
      {
        draft: input.draft,
        passed: input.passed,
        score: input.score,
        threshold,
        iterations: input.iterations,
        rationale: input.critique,
        ...([note, capNote].filter(Boolean).length > 0 && {
          note: [note, capNote].filter(Boolean).join(" "),
        }),
      },
      {
        reason: input.passed
          ? "draft cleared the rubric"
          : "published the best draft after exhausting the attempt cap",
      },
    );
  },
});

/**
 * The agent. The engine imports THIS `agent` export, bundles it, and walks
 * these step bodies inside a sandbox. Exactly ONE `defineAgent` is exported
 * from this module — the loader requires precisely one.
 */
export const agent = defineAgent<WriterInput, WriterShared>({
  name: "self-editing-writer",
  entry: "parse",
  steps: { parse, draft, judge, decide, publish },
});
