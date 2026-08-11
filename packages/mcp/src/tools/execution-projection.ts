/**
 * Compact-by-default projection of an execution for the `sapiom_dev_agents_inspect`
 * tool result (SAP-2533).
 *
 * The canonical {@link ExecutionProjection} carries every step's full
 * input/output/shared-state/logs/events/stack-trace plus the whole child-run
 * tree, uncapped. On a real multi-step (retry-fattened) run that is a 365K–3.3M
 * char payload that overflows the consuming model's context — so the debug tool
 * self-destructs exactly when it is needed most.
 *
 * This projection lives at the MCP-tool layer only; the SDK `inspect()` /
 * `decode` passthrough and the CLI `logs` view still receive the full
 * projection. It does three things:
 *
 *  1. **Compact by default.** Identity/status/timestamps are kept as-is (already
 *     small). Every step is reduced to its name/order/attempt/status/timestamps
 *     + error message, plus a `has` flag-set and a `sizes` hint (char counts of
 *     the omitted heavy bodies) so the caller can see WHERE the weight is
 *     without paying for it. Heavy top-level fields (input/sharedState/
 *     output/error/paused-step schema+example) are previewed or budgeted, never
 *     copied verbatim.
 *  2. **Selective expansion.** `step` (name or order) + optional `attempt` pick
 *     step-attempt(s); `include` names which heavy fields to expand for them.
 *     The debug loop is: inspect(id) → compact list shows step 4 failed →
 *     inspect(id, step:'validate', include:['input','error']) → exactly the
 *     payload run_local needs.
 *  3. **Hard char budget.** Every expanded or previewed field is capped, so the
 *     result is bounded for ANY argument combination — the property the raw
 *     projection lacks. Over-budget values truncate with an honest marker that
 *     cites the dropped count and the run's webappUrl.
 */
import type { ExecutionProjection, StepProjection } from "@sapiom/agent-core";

import { capText } from "./shared.js";

/** Heavy step fields the caller may ask to expand via `include`. */
export const INCLUDABLE_FIELDS = [
  "input",
  "output",
  "logs",
  "events",
  "sharedState",
  "error",
] as const;

export type IncludableField = (typeof INCLUDABLE_FIELDS)[number];

export interface ProjectExecutionOptions {
  /** Step to expand: a step name, or a step order (number or numeric string). */
  step?: string | number;
  /** Restrict expansion to a single attempt of the selected step. */
  attempt?: number;
  /** Heavy step fields to expand for the selected step(s). */
  include?: IncludableField[];
  /** Per-field character budget for expanded / budgeted fields. */
  budget?: number;
  /** The run's webapp URL, cited in truncation markers. */
  webappUrl?: string;
}

/** Per-field cap for expanded step fields and budgeted top-level fields. A single
 *  step output can be multiple MB; 32K keeps a truncated body readable while
 *  bounding the result. */
const DEFAULT_FIELD_BUDGET = 32_000;

/** Small preview cap for message-only top-level fields (output/error/input/
 *  sharedState) in the compact view — presence + first N chars, no full body. */
const PREVIEW_BUDGET = 2_000;

/** Serialized char size of a value; null/undefined count as 0 (honest absence). */
function charSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** True when a heavy field carries an actual body worth expanding. */
function hasBody(value: unknown): boolean {
  return value !== undefined && value !== null && charSize(value) > 0;
}

/**
 * Budget an arbitrary value: return it verbatim (structured) when its serialized
 * form fits `budget`, otherwise a truncated string preview with an honest marker.
 * Returning the value verbatim when it fits keeps a small step input directly
 * usable by run_local; truncating only over-budget values bounds the result.
 */
function budgetValue(
  value: unknown,
  budget: number,
  webappUrl?: string,
): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (serialized.length <= budget) return value;
  return capText(serialized, budget, webappUrl);
}

/** A message-only preview of a heavy top-level field: presence + first N chars,
 *  never the full body. Returns null for an absent value so the key still
 *  signals "nothing here" rather than vanishing. */
function previewValue(
  value: unknown,
  webappUrl?: string,
): { chars: number; preview: unknown } | null {
  if (value === undefined || value === null) return null;
  const chars = charSize(value);
  return { chars, preview: budgetValue(value, PREVIEW_BUDGET, webappUrl) };
}

/** Extract a human message from an arbitrary top-level error value (which may be
 *  a structured `{ message }`, a string, or something else). */
function errorMessageOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  ) {
    return (value as { message: string }).message;
  }
  return null;
}

interface CompactStep {
  stepName: string;
  stepOrder: number;
  attempt: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  has: Record<IncludableField | "dispatch", boolean>;
  sizes: Record<IncludableField, number>;
  dispatch?: StepProjection["dispatch"];
  cost?: StepProjection["cost"];
  // Expanded heavy fields, present only when the step is selected + included.
  input?: unknown;
  output?: unknown;
  logs?: unknown;
  events?: unknown;
  sharedState?: unknown;
  error?: unknown;
}

/** The heavy value backing each includable field on a step. */
function stepFieldValue(step: StepProjection, field: IncludableField): unknown {
  switch (field) {
    case "input":
      return step.input;
    case "output":
      return step.output;
    case "logs":
      return step.logs;
    case "events":
      return step.events;
    case "sharedState":
      return step.sharedStateAfter;
    case "error":
      return step.error;
  }
}

/** Does this step-attempt match the caller's `step` / `attempt` selector? */
function stepMatches(
  step: StepProjection,
  selector: string | number | undefined,
  attempt: number | undefined,
): boolean {
  if (selector === undefined) return false;
  if (attempt !== undefined && step.attempt !== attempt) return false;
  // A numeric selector (or numeric string) matches by stepOrder; otherwise by name.
  const asNumber = typeof selector === "number" ? selector : Number(selector);
  if (
    typeof selector === "number" ||
    (selector.trim() !== "" && !Number.isNaN(asNumber))
  ) {
    return step.stepOrder === asNumber || step.stepName === String(selector);
  }
  return step.stepName === selector;
}

function compactStep(
  step: StepProjection,
  expand: IncludableField[],
  budget: number,
  webappUrl?: string,
): CompactStep {
  const sizes: Record<IncludableField, number> = {
    input: charSize(step.input),
    output: charSize(step.output),
    logs: charSize(step.logs),
    events: charSize(step.events),
    sharedState: charSize(step.sharedStateAfter),
    error: charSize(step.error),
  };
  const out: CompactStep = {
    stepName: step.stepName,
    stepOrder: step.stepOrder,
    attempt: step.attempt,
    status: step.status,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    errorMessage: step.error?.message ?? null,
    has: {
      input: hasBody(step.input),
      output: hasBody(step.output),
      logs: hasBody(step.logs),
      events: hasBody(step.events),
      sharedState: hasBody(step.sharedStateAfter),
      error: step.error !== null && step.error !== undefined,
      dispatch: step.dispatch !== null && step.dispatch !== undefined,
    },
    sizes,
  };
  // Dispatch and cost are small, bounded structured nodes — keep them verbatim so
  // the compact view still tells the "which child run / what did it cost" story.
  if (step.dispatch) out.dispatch = step.dispatch;
  if (step.cost) out.cost = step.cost;
  for (const field of expand) {
    out[field] = budgetValue(stepFieldValue(step, field), budget, webappUrl);
  }
  return out;
}

/**
 * Project a full {@link ExecutionProjection} into the bounded compact shape the
 * inspect tool returns. Identity/status/timestamps/tree/cost are kept as-is;
 * every step is compacted (with a `has`/`sizes` hint); heavy top-level fields are
 * previewed or budgeted; and the selected `step`/`attempt` gets its `include`
 * fields expanded within the per-field budget.
 */
export function projectExecutionForTool(
  execution: ExecutionProjection,
  opts: ProjectExecutionOptions = {},
): Record<string, unknown> {
  const budget = opts.budget ?? DEFAULT_FIELD_BUDGET;
  const webappUrl = opts.webappUrl;
  const include = opts.include ?? [];
  const wantsExpansion = opts.step !== undefined && include.length > 0;

  const steps = execution.steps.map((step) => {
    const expand =
      wantsExpansion && stepMatches(step, opts.step, opts.attempt)
        ? include
        : [];
    return compactStep(step, expand, budget, webappUrl);
  });

  return {
    // ── identity / status (kept as-is; already small) ──
    id: execution.id,
    name: execution.name,
    organizationId: execution.organizationId,
    tenantId: execution.tenantId,
    status: execution.status,
    currentStep: execution.currentStep,
    currentStepAttempt: execution.currentStepAttempt,
    version: execution.version,
    definitionId: execution.definitionId,
    buildRunId: execution.buildRunId,
    idempotencyKey: execution.idempotencyKey,
    pausedSignalName: execution.pausedSignalName,
    pausedSignalCorrelationId: execution.pausedSignalCorrelationId,
    pausedUntil: execution.pausedUntil,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,

    // ── tree / trace (lightweight refs; kept as-is) ──
    traceRoot: execution.traceRoot,
    rootExecutionId: execution.rootExecutionId,
    traceParent: execution.traceParent,
    parentExecutionId: execution.parentExecutionId,
    traceId: execution.traceId,
    children: execution.children,

    // ── run-level cost rollup (small structured node) ──
    cost: execution.cost,

    // ── heavy top-level detail: message-only previews / budgeted, never verbatim ──
    input: previewValue(execution.input, webappUrl),
    sharedState: previewValue(execution.sharedState, webappUrl),
    output: previewValue(execution.output, webappUrl),
    error: previewValue(execution.error, webappUrl),
    errorMessage: errorMessageOf(execution.error),
    // Paused-step schema/example matter for resume; budget (verbatim when small).
    pausedStepInputSchema: budgetValue(
      execution.pausedStepInputSchema,
      budget,
      webappUrl,
    ),
    pausedStepInputExample: budgetValue(
      execution.pausedStepInputExample,
      budget,
      webappUrl,
    ),

    // ── steps (compacted; selected step's included fields expanded) ──
    steps,
  };
}
