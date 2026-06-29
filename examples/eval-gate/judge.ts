/**
 * judge.ts — the eval-gate's only genuinely new code.
 *
 * Three small pieces: a default judge prompt, a gateway call, and a text score
 * parser. The RUBRIC is the caller's — we own the harness, not an opinion about
 * what "quality" means. This file is factored out (not inlined in the steps) so
 * the async/eventually eval variant reuses the EXACT same judge with no change;
 * only its execution mode differs.
 *
 * The judge is reached via the Sapiom LLM gateway read from `LLM_GATEWAY_*`
 * because `@sapiom/tools` has no `llm` capability YET. When it lands, `callJudge`
 * swaps for `ctx.sapiom.llm.*` with no behavior change — and because the judge is
 * an ordinary gateway call, the engine's routing/capacity layer sits in front of
 * it for free. No evals-specific execution path is created.
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
 * too (no structured-output support on the gateway yet).
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

/**
 * Issue the judge call through the Sapiom LLM gateway (read from `LLM_GATEWAY_*`).
 * This is the load-bearing seam: the judge is an ordinary gateway LLM call, so it
 * rides the same step→gateway path as everything else.
 */
export async function callJudge(
  prompt: string,
  model?: string,
): Promise<string> {
  const base = process.env.LLM_GATEWAY_BASE_URL;
  const key = process.env.LLM_GATEWAY_API_KEY;
  const judgeModel =
    model ?? process.env.LLM_GATEWAY_MODEL ?? "claude-sonnet-4-6";
  if (!base || !key) {
    throw new Error(
      "eval-gate requires LLM_GATEWAY_BASE_URL + LLM_GATEWAY_API_KEY (the Sapiom LLM gateway).",
    );
  }
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: judgeModel,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(
      `LLM gateway ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}
