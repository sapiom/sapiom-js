import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

import { buildJudgePrompt, parseScore } from "./judge.js";

/**
 * eval-gate
 * ---------
 * An LLM-judge quality gate. Score an output against YOUR rubric, then gate the
 * next step on the score — a deployable Sapiom agent built from primitives you
 * already have: one metered LLM call (the judge, via `ctx.sapiom.models.run`),
 * the engine's branch control flow (the gate), and two terminal outcomes
 * (publish / revise).
 *
 * We own the harness (a default judge prompt + a score parser, see `judge.ts`)
 * and the pattern. The RUBRIC is yours — we ship one generic default judge prompt
 * you override, never an opinion about what "quality" means.
 *
 *   judge ─▶ gate ─┬─▶ publish   (score >= threshold)
 *                  └─▶ revise    (score <  threshold)
 *
 * The judge is an ordinary `models.run` call, so it rides the same step→gateway
 * path as everything else and inherits the engine's routing / capacity / load
 * balancing for free — no evals-specific execution path is created.
 *
 * Shape: `(input, output, rubric, threshold) → { decision, score, threshold,
 * rationale }`. Copy this as a starter, or call it as a CHILD from a parent
 * workflow that produced `output` and branch on the returned decision — see the
 * "self-grading workflow" composition pattern in `README.md`.
 */

/** Run-scoped values stashed in `ctx.shared` so later steps can read them. */
interface EvalShared extends Record<string, unknown> {
  /** The pass bar, stashed by `judge` so `gate` can branch on it. */
  threshold: number;
}

const judgeInputSchema = z
  .object({
    input: z
      .unknown()
      .describe(
        "The case the output was produced from (task, prompt, question…).",
      ),
    output: z.unknown().describe("The produced output to grade."),
    rubric: z
      .string()
      .min(1)
      .describe(
        "YOUR criteria. The judge scores the output against this — we ship no scorer taxonomy.",
      ),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.7)
      .describe(
        "Pass bar in [0,1]. score >= threshold ⇒ publish, else revise.",
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Judge-model alias the models capability knows (default: the configured judge model).",
      ),
  })
  .meta({
    examples: [
      {
        input:
          "Write a one-line product tagline for a privacy-first email app.",
        output: "Inbox peace, finally — email that never reads your mail.",
        rubric:
          "Concise (<= 12 words), mentions privacy, no jargon, reads naturally.",
        threshold: 0.7,
      },
    ],
  });

/** What the workflow is kicked off with. */
export type EvalGateInput = z.infer<typeof judgeInputSchema>;

// ---------------------------------------------------------------------------
// Step 1 — judge: build the prompt from YOUR rubric, call models.run, parse score
// ---------------------------------------------------------------------------

const judge = defineStep({
  name: "judge",
  next: ["gate"],
  timeoutMs: 60_000,
  inputSchema: judgeInputSchema,
  async run(input: EvalGateInput, ctx: AgentExecutionContext<EvalShared>) {
    ctx.shared.set("threshold", input.threshold);
    const prompt = buildJudgePrompt({
      input: input.input,
      output: input.output,
      rubric: input.rubric,
    });
    // The load-bearing seam: the judge is an ordinary metered LLM call. A
    // malformed reply (or none) makes `parseScore` throw, so the engine retries.
    const res = await ctx.sapiom.models.run({
      prompt,
      model: input.model,
      maxTokens: 256,
    });
    const { score, rationale } = parseScore(res.output ?? "");
    ctx.logger.info("judge: scored output against rubric", {
      score,
      threshold: input.threshold,
    });
    return goto("gate", { score, rationale });
  },
});

// ---------------------------------------------------------------------------
// Step 2 — gate: the branch the whole template turns on (pure logic, no call)
// ---------------------------------------------------------------------------

interface GateInput {
  score: number;
  rationale: string;
}

interface GateOutcome {
  score: number;
  threshold: number;
  rationale: string;
}

const gate = defineStep({
  name: "gate",
  next: ["publish", "revise"],
  async run(input: GateInput, ctx: AgentExecutionContext<EvalShared>) {
    const threshold = ctx.shared.get("threshold") ?? 0.7;
    const passed = input.score >= threshold;
    ctx.logger.info(
      `gate: score ${passed ? "met" : "below"} threshold → ${passed ? "publish" : "revise"}`,
      { score: input.score, threshold },
    );
    const outcome: GateOutcome = {
      score: input.score,
      threshold,
      rationale: input.rationale,
    };
    return passed ? goto("publish", outcome) : goto("revise", outcome);
  },
});

// ---------------------------------------------------------------------------
// Step 3 — terminal outcomes. The caller decides what publish/revise MEAN.
// ---------------------------------------------------------------------------

const publish = defineStep({
  name: "publish",
  next: [],
  terminal: true,
  async run(input: GateOutcome, ctx: AgentExecutionContext<EvalShared>) {
    ctx.logger.info("publish: output passed the eval-gate", {
      score: input.score,
    });
    return terminate(
      {
        decision: "publish",
        score: input.score,
        threshold: input.threshold,
        rationale: input.rationale,
      },
      { reason: "score met threshold" },
    );
  },
});

const revise = defineStep({
  name: "revise",
  next: [],
  terminal: true,
  async run(input: GateOutcome, ctx: AgentExecutionContext<EvalShared>) {
    ctx.logger.info("revise: output failed the eval-gate", {
      score: input.score,
    });
    return terminate(
      {
        decision: "revise",
        score: input.score,
        threshold: input.threshold,
        rationale: input.rationale,
      },
      { reason: "score below threshold" },
    );
  },
});

/**
 * The agent. The engine imports THIS `agent` export, bundles it, and walks these
 * step bodies inside a sandbox. Exactly ONE `defineAgent` is exported from this
 * module — the loader requires precisely one.
 */
export const agent = defineAgent<EvalGateInput, EvalShared>({
  name: "eval-gate",
  entry: "judge",
  steps: { judge, gate, publish, revise },
});
