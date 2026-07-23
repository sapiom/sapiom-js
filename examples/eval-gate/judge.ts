/**
 * judge.ts — the eval-gate's only genuinely new code.
 *
 * Two small pieces: a default judge prompt builder and a text score parser. The
 * RUBRIC is the caller's — we own the harness, not an opinion about what
 * "quality" means. These are factored out (not inlined in the steps) so the same
 * judge scaffolding is reusable if you compose the eval-gate as a child of your
 * own workflow.
 *
 * There is NO gateway call in this file. The judge LLM call lives in the `judge`
 * step in `index.ts` and goes through `ctx.sapiom.models.run` — the real,
 * deploy-injected, metered LLM path (x402 at `tools.sapiom.ai/models/v1`). This
 * file only builds the prompt string and parses the score out of the reply.
 */

export interface JudgeResult {
  /** Score in [0,1]: 1.0 fully satisfies the rubric, 0.0 not at all. */
  score: number;
  /** Best-effort one-line model explanation (empty when the reply carried none). */
  rationale: string;
}

/**
 * Build the single default judge prompt from the caller's rubric. This is the
 * unopinionated default — override the RUBRIC, not this scaffolding. We ask for a
 * JSON object so the parse is robust, but `parseScore` tolerates a bare number
 * too.
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
    "satisfies the CRITERIA — 1.0 = fully satisfies, 0.0 = does not satisfy at all.",
    'Respond with ONLY a JSON object: {"score": <number 0..1>, "rationale": "<one sentence>"}.',
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
 * Parse a [0,1] score (and best-effort rationale) out of the model's text reply.
 * Prefers the JSON object the prompt asked for; falls back to the first bare
 * number in the text. Throws when no number can be found at all — a malformed
 * reply is treated as transient, so the engine retries the step up to its cap.
 */
export function parseScore(reply: string): JudgeResult {
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
      `eval-gate judge: could not parse a score from reply: ${reply.slice(0, 200)}`,
    );
  }
  return { score: clamp01(Number(m[0])), rationale: "" };
}
