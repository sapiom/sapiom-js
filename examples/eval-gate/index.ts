/**
 * eval-gate
 * ---------
 * Score an output against a rubric, gate the next step on the score — authored as
 * a DEPLOYABLE Sapiom orchestration. The eval-gate is NOT a capability. It is a
 * reference template built entirely from primitives you already have: a single
 * LLM call through the gateway (the judge, see `judge.ts`), the engine's branch
 * control flow (the gate), and two terminal outcomes (publish / revise). We own
 * the harness and the pattern; the RUBRIC is yours — we ship one generic default
 * judge prompt you override, never an opinion about what "quality" means.
 *
 * Load-bearing seam: the judge is an ordinary gateway LLM call, so it rides the
 * same step→gateway path as everything else and inherits the engine's routing /
 * capacity / load-balancing for free.
 *
 *   judge ─▶ gate ─┬─▶ publish   (score >= threshold)
 *                  └─▶ revise    (score <  threshold)
 *
 * This file is the DEPLOYABLE ARTIFACT and is therefore SIDE-EFFECT-FREE: it only
 * defines steps and exports exactly ONE `defineOrchestration`. There is no
 * `main()`, no `runLocal` call, no top-level execution — so the engine can import
 * and bundle it cleanly. The harness that runs it locally lives in `run-local.ts`.
 * `judge.ts` exports plain functions (not orchestrations), so importing it here is
 * safe — the loader still finds exactly one definition.
 *
 * Shape: (input, output, rubric, threshold) → { decision, score }. Copy this as a
 * starter, or call it by slug via `orchestrations.launch` from a parent workflow
 * that produced `output` and branch on the returned decision.
 */
import {
  defineOrchestration,
  defineStep,
  goto,
  terminate,
  type OrchestrationExecutionContext,
} from "@sapiom/orchestration";
import { z } from "zod/v4";

import { buildJudgePrompt, callJudge, parseScore } from "./judge.js";

/** Run-scoped values stashed in `ctx.shared` so later steps can read them. */
export interface EvalShared extends Record<string, unknown> {
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
        "Judge-model alias the LLM gateway knows (default: a configured cheap judge).",
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
// Step 1 — judge: build the prompt from YOUR rubric, call the gateway, parse score
// ---------------------------------------------------------------------------

const judge = defineStep({
  name: "judge",
  next: ["gate"],
  timeoutMs: 60_000,
  inputSchema: judgeInputSchema,
  async run(
    input: EvalGateInput,
    ctx: OrchestrationExecutionContext<EvalShared>,
  ) {
    ctx.shared.set("threshold", input.threshold);
    const prompt = buildJudgePrompt({
      input: input.input,
      output: input.output,
      rubric: input.rubric,
    });
    const { score, rationale } = parseScore(
      await callJudge(prompt, input.model),
    );
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
  async run(input: GateInput, ctx: OrchestrationExecutionContext<EvalShared>) {
    const threshold = ctx.shared.get("threshold") ?? 0.7;
    const passed = input.score >= threshold;
    ctx.logger.info(
      `gate: score ${passed ? "met" : "below"} threshold → ${passed ? "publish" : "revise"}`,
      {
        score: input.score,
        threshold,
      },
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
  terminal: true,
  async run(
    input: GateOutcome,
    ctx: OrchestrationExecutionContext<EvalShared>,
  ) {
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
  terminal: true,
  async run(
    input: GateOutcome,
    ctx: OrchestrationExecutionContext<EvalShared>,
  ) {
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
 * The workflow. The engine imports THIS `evalGate` export, bundles it, and walks
 * these step bodies inside a Blaxel sandbox. Exactly ONE `defineOrchestration` is
 * exported from this module — the orchestration-core loader requires precisely one.
 */
export const evalGate = defineOrchestration<EvalGateInput, EvalShared>({
  name: "eval-gate",
  entry: "judge",
  steps: { judge, gate, publish, revise },
});
