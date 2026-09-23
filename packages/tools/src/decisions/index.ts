/**
 * `decisions.evaluate` — a fixed-answer-set decision with probabilities, backed by
 * a System One decision model through the Capability Router
 * (`POST /v1/capabilities/decisions.evaluate`, SAP-3569). Where `llm.run`
 * generates text or JSON, `decisions.evaluate` returns calibrated probabilities
 * over answers the caller defines up front.
 *
 * Pick it by the shape of the work: a yes/no gate, a pick-one classification, or a
 * rubric score you want a probability for → `decisions.evaluate`. Generated
 * content → `llm.run`. System One decisions are not a security boundary and are
 * weak at arithmetic and date math — keep those in code.
 *
 *   const res = await ctx.sapiom.decisions.evaluate({
 *     state: { message: ticket.body },
 *     questions: {
 *       urgent: { type: "noul", instructions: "Is this urgent?" },
 *       team: {
 *         type: "choice",
 *         instructions: "Which team should handle `message`?",
 *         criteria: { shipping: "Delivery issues", billing: "Charges and refunds", other: null },
 *       },
 *     },
 *   });
 *   if (res.answers.urgent.noul > 0.8) escalate(res.answers.team.choice);
 *
 * Ask every independent question over the same state in ONE call: they are
 * evaluated in parallel and cannot see each other's answers. The answers map is
 * typed by the questions you passed, so `res.answers.team.choice` type-checks.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import {
  capabilityCall,
  resolveCoreBaseUrl,
} from "../_client/capability-call.js";

/** `state` and `instructions` accept prose or structured JSON; prefer named fields when the context has several parts. */
export type DecisionContent = string | Record<string, unknown> | unknown[];

/** Whether a condition holds. The answer is the probability of "yes". */
export interface NoulQuestion {
  type: "noul";
  instructions: DecisionContent;
  /** Optional descriptions of what a `true` / `false` answer means. */
  criteria?: { true?: string; false?: string };
}

/** One option out of a defined set. The answer carries the full distribution. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: DecisionContent;
  /** Option name → description (or `null` when the name is self-explanatory). Include a no-match option when nothing may fit. */
  criteria: Record<string, string | null>;
}

/** Degree along an ordered rubric. The answer is a probability-weighted level. */
export interface ScoreQuestion {
  type: "score";
  instructions: DecisionContent;
  /** Ordered level descriptions, lowest first; each must describe a concrete situation. */
  criteria: string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  /** Probability of "yes", 0–1. Near 0.5 means undecided, not "moderately". */
  noul: number;
}

export interface ChoiceAnswer<Option extends string = string> {
  type: "choice";
  /** The highest-probability option. */
  choice: Option;
  /** Every option → its probability; sums to 1. */
  probabilities: Record<Option, number>;
  /** 0–1: how concentrated the distribution is, not whether the choice is correct. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted position across the levels, 0 … levels-1. */
  score: number;
  /** Level index (as a string) → the level description you passed. */
  legend: Record<string, string>;
  /** Level index (as a string) → probability. */
  probabilities: Record<string, number>;
  /** 0–1: how concentrated the distribution is. */
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type a given question produces — this is what types `answers` per key. */
export type DecisionAnswerFor<Q extends DecisionQuestion> =
  Q extends ChoiceQuestion
    ? ChoiceAnswer<Extract<keyof Q["criteria"], string>>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : NoulAnswer;

export interface DecisionsEvaluateSpec<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> {
  /** What every question is evaluated against. */
  state: DecisionContent;
  /** Named questions, all evaluated in parallel over `state`. Names are for your code; the model never sees them. */
  questions: Q;
  /**
   * Optional platform model id. Omit it and the platform picks the current
   * default System One model.
   */
  model?: string;
}

export interface DecisionsEvaluateResponse<
  Q extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> {
  /** One answer per question, under the same keys. */
  answers: { [K in keyof Q]: DecisionAnswerFor<Q[K]> };
  usage: { inputTokens: number; outputTokens: number };
  /** Optional quote metadata. The estimate is not the settled charge. */
  cost?: {
    estimateUsd?: number;
    currency?: string;
    /** Transaction id for looking up the settled cost. */
    reference?: string;
    isEstimate?: true;
    source?: "quote";
  };
}

/** Thrown when the router answers a non-2xx (validation, metering, or provider failure). */
export class DecisionsHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "DecisionsHttpError";
  }
}

/**
 * Evaluate fixed-answer-set questions over a state. Routed and metered per call;
 * the router validates the questions before any spend. Failed requests throw
 * {@link DecisionsHttpError}.
 */
export async function evaluate<Q extends Record<string, DecisionQuestion>>(
  spec: DecisionsEvaluateSpec<Q>,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<DecisionsEvaluateResponse<Q>> {
  // `!= null` so a JS caller passing `model: null` gets the default rather than
  // forwarding a null the router would reject.
  const body: Record<string, unknown> = {
    state: spec.state,
    questions: spec.questions,
  };
  if (spec.model != null) body.model = spec.model;

  const response = await capabilityCall<DecisionsEvaluateResponse<Q>>(
    "decisions.evaluate",
    body,
    {
      transport,
      baseUrl,
      makeError: (message, status, errorBody) =>
        new DecisionsHttpError(message, status, errorBody),
      errorPrefix: "Failed to evaluate",
    },
  );
  // Return only public decision data.
  return {
    answers: response.answers,
    usage: response.usage,
    ...(response.cost === undefined ? {} : { cost: response.cost }),
  };
}
