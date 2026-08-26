/**
 * judge.ts — the eval-gate's only genuinely new code.
 *
 * Two small pieces: a default judge prompt builder and a text score parser. The
 * RUBRIC is the caller's — we own the harness, not an opinion about what
 * "quality" means. These are factored out (not inlined in the steps) so the same
 * judge scaffolding is reusable if you compose the eval-gate as a child of your
 * own agent.
 *
 * There is NO gateway call in this file. The judge LLM call lives in the `judge`
 * step in `index.ts` and goes through `ctx.sapiom.llm.run` — the real,
 * deploy-injected, metered LLM gateway path. This file only builds the prompt
 * string and parses the score out of the reply.
 */

export interface JudgeResult {
  /** Score in [0,1]: 1.0 fully satisfies the rubric, 0.0 not at all. */
  score: number;
  /** Best-effort one-line model explanation (empty when the reply carried none). */
  rationale: string;
}

/**
 * Build the single default judge prompt from the caller's rubric. This is the
 * unopinionated default — override the RUBRIC, not this scaffolding. The reply
 * shape is not asked for in words: it is pinned by {@link JUDGE_SCHEMA}, which
 * `llm.run`'s `output` turns into a forced tool call.
 */
export function buildJudgePrompt(args: {
  input: unknown;
  output: unknown;
  rubric: string;
}): string {
  const { input, output, rubric } = args;
  const render = (v: unknown): string =>
    typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return [
    "You are an impartial evaluator. Score the OUTPUT from 0.0 to 1.0 on how well it",
    "satisfies the CRITERIA — 1.0 = fully satisfies, 0.0 = does not satisfy at all —",
    "and say in one sentence why.",
    "",
    "CRITERIA (the rubric — supplied by the caller):",
    rubric,
    "",
    "INPUT (what the output was produced from):",
    render(input),
    "",
    "OUTPUT (the thing you are grading):",
    render(output),
  ].join("\n");
}

/** Clamp to [0,1], tolerating a model that answered on a 0–100 scale. */
function clamp01(n: number): number {
  const v = n > 1 && n <= 100 ? n / 100 : n;
  return Math.max(0, Math.min(1, v));
}

/**
 * The forced tool call the `judge` step reads its score out of. `llm.run`'s
 * `output` appends this tool to the request and pins `tool_choice` to it, so the
 * score arrives as a typed `tool_use` block — there is no prose to search for a
 * number in.
 */
export const JUDGE_TOOL = "emit_score";

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "How well the output satisfies the criteria: 1.0 fully, 0.0 not at all.",
    },
    rationale: {
      type: "string",
      description: "One sentence on why it scored that way.",
    },
  },
  required: ["score", "rationale"],
  additionalProperties: false,
};

/**
 * Read the forced tool call back into a `JudgeResult`.
 *
 * Throws when the grade carries no usable number, so the engine retries the step
 * up to its cap rather than the run treating a non-answer as a score. This
 * replaced a regex that fell back to the first bare number anywhere in the
 * reply — which could pick a figure out of the model's prose and grade the draft
 * on it. A score the judge did give but outside [0,1] is clamped; a score it did
 * not give is an error.
 */
export function readScore(structured: unknown): JudgeResult {
  if (structured === null || typeof structured !== "object") {
    throw new Error("eval-gate judge: the judge returned no structured score");
  }
  const obj = structured as { score?: unknown; rationale?: unknown };
  // `typeof`, not `Number(...)`: `Number(null)`, `Number("")`, `Number([])` and
  // `Number(false)` are all a finite `0`, so coercing would turn "the judge gave
  // no score" back into a grade of 0.0 — the substituted score this refuses.
  if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) {
    throw new Error(
      `eval-gate judge: the judge returned no usable score (${JSON.stringify(obj.score)})`,
    );
  }
  return {
    score: clamp01(obj.score),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}
