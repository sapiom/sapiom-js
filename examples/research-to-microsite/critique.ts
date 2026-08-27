/**
 * critique.ts — the eval-gate-style self-critique this template folds in
 * (see the Self-Editing Writer, `examples/eval-gate`): a judge prompt scoped to
 * a cited RESEARCH REPORT specifically (citation coverage, redundancy, tone
 * for the audience), plus the forced-tool schema its grade comes back in.
 * Mirrors eval-gate's `judge.ts` on purpose — factored out for the same reason:
 * the judge LLM call itself lives in the `critique` step in `index.ts`, via
 * `ctx.sapiom.llm.run`; this file only builds the prompt string and reads the
 * grade back off the reply. No gateway call lives here.
 */

/** The report shape the judge grades — structural, so this file never needs
 * to import the richer `Report` type from `index.ts`. */
export interface CritiqueReportInput {
  title: string;
  tagline: string;
  summary: string;
  sections: { heading: string; body: string }[];
  sources: { title: string; url: string }[];
}

/**
 * Build the judge prompt. The rubric is fixed, not caller-supplied — this
 * template owns an opinion about what a publishable cited report looks like,
 * unlike the generic eval-gate harness.
 */
export function buildCritiquePrompt(args: {
  report: CritiqueReportInput;
  audience: string;
}): string {
  const { report, audience } = args;
  return [
    "You are an exacting editor reviewing a cited research report before it is",
    "published as a web micro-site. Score the REPORT from 0.0 to 1.0 against the",
    "CRITERIA below, and say in one sentence why.",
    "",
    "CRITERIA:",
    "- Every section supports its claims with at least one [n] citation to a source listed below.",
    "- No two sections just restate each other — each earns its place.",
    `- The tone and depth suit the audience: ${audience}.`,
    "- The summary accurately previews what the sections actually say.",
    "",
    "REPORT (JSON):",
    JSON.stringify(report),
  ].join("\n");
}

export interface Judgment {
  /** Score in [0,1]: 1.0 fully satisfies the criteria, 0.0 not at all. */
  score: number;
  /** Best-effort one-line explanation (empty when the reply carried none). */
  rationale: string;
}

/** Clamp to [0,1], tolerating a model that answered on a 0–100 scale. */
function clamp01(n: number): number {
  const v = n > 1 && n <= 100 ? n / 100 : n;
  return Math.max(0, Math.min(1, v));
}

/**
 * The forced tool call the `critique` step reads the judge's grade out of.
 * `llm.run`'s `output` appends this tool to the request and pins `tool_choice`
 * to it, so the grade arrives as a typed `tool_use` block — there is no prose
 * to search for a number in.
 */
export const CRITIQUE_TOOL = "emit_judgment";

export const CRITIQUE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "How fully the report satisfies the criteria: 1.0 fully, 0.0 not at all.",
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
 * Read the forced tool call back into a `Judgment`.
 *
 * Throws when the grade carries no usable number. This replaced a regex that
 * fell back to the first bare number anywhere in the reply — which could pick a
 * figure out of the model's prose and treat it as the score. A score the judge
 * did give but outside [0,1] is clamped; a score it did not give is an error.
 */
export function readJudgment(structured: unknown): Judgment {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "research-to-microsite critique: the judge returned no structured grade",
    );
  }
  const obj = structured as { score?: unknown; rationale?: unknown };
  // `typeof`, not `Number(...)`: `Number(null)`, `Number("")`, `Number([])` and
  // `Number(false)` are all a finite `0`, so coercing would turn "the judge gave
  // no score" back into a grade of 0.0 — a rejection nobody issued, which then
  // spends another model call on a revision.
  if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) {
    throw new Error(
      `research-to-microsite critique: the judge returned no usable score (${JSON.stringify(obj.score)})`,
    );
  }
  return {
    score: clamp01(obj.score),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}
