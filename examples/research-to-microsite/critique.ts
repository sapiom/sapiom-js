/**
 * critique.ts — the eval-gate-style self-critique this template folds in
 * (see the Self-Editing Writer, `examples/eval-gate`): a judge prompt scoped to
 * a cited RESEARCH REPORT specifically (citation coverage, redundancy, tone
 * for the audience), and a tolerant score parser. Mirrors eval-gate's
 * `judge.ts` on purpose — factored out for the same reason: the judge LLM
 * call itself lives in the `critique` step in `index.ts`, via
 * `ctx.sapiom.llm.run`; this file only builds the prompt string and parses
 * the score out of the reply. No gateway call lives here.
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
    'CRITERIA below. Respond with ONLY a JSON object: {"score": <number 0..1>, "rationale": "<one sentence>"}.',
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
 * Parse a [0,1] score (and best-effort rationale) out of the judge's text
 * reply. Prefers the JSON object the prompt asked for; falls back to the
 * first bare number in the text. Throws when no number can be found at all —
 * a malformed reply is treated as transient, so the engine retries the step
 * rather than the run silently treating gibberish as a passing (or failing)
 * score.
 */
export function parseJudgment(reply: string): Judgment {
  const json = reply.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const obj = JSON.parse(json[0]) as {
        score?: unknown;
        rationale?: unknown;
      };
      const n = Number(obj.score);
      if (Number.isFinite(n)) {
        return {
          score: clamp01(n),
          rationale: typeof obj.rationale === "string" ? obj.rationale : "",
        };
      }
    } catch {
      // Not valid JSON — fall through to the bare-number path.
    }
  }
  const m = reply.match(/-?\d+(?:\.\d+)?/);
  if (!m) {
    throw new Error(
      `research-to-microsite critique: could not parse a score from reply: ${reply.slice(0, 200)}`,
    );
  }
  return { score: clamp01(Number(m[0])), rationale: "" };
}
