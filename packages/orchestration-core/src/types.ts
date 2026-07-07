/**
 * Canonical projection types for the workflows inspection surface.
 *
 * Single owner of the SDK inspection signatures — mirrors the REST
 * `ExecutionProjection` contract (Module P / SAP-1138) as defined in the
 * live-observable-execution `interfaces.md`. Consumers (CLI, MCP tools, watch)
 * import these; they must NOT redefine them.
 *
 * Design rules baked into these shapes:
 *   - Cost is per-node and NEVER collapses authorized vs captured — every
 *     cost-bearing node carries both plus a `settleState` (txn → step → run).
 *   - Identity is trace-keyed: `traceRoot`/`traceParent`/`traceId`/`spanId`,
 *     with engine lineage (`parentExecutionId`/`rootExecutionId`) as aliases.
 *   - Dispatch edges and step errors are TYPED (`DispatchRef` / `StepError`),
 *     not string-sniffed from a signal correlation id or a raw stack blob.
 *
 * These are pure structural types (no swagger/class decorators) — the SDK is a
 * thin passthrough of the REST shape and does not reshape or recompute cost.
 */

/**
 * Settlement progress over a cost node's active transaction rows.
 * `BOOL_OR(is_estimate)` collapsed to a tri-state: `pending` (only estimates),
 * `settling` (mixed), `final` (all captured).
 */
export type SettleState = "pending" | "settling" | "final";

/**
 * Per-node capability cost — authorized (x402 pre-auth hold / ceiling) and
 * captured (settled) are carried separately and are NEVER collapsed into one
 * number. USD amounts are decimal STRINGS to avoid float drift; `"0"` when a
 * leg has no active rows.
 */
export interface CostNode {
  /** Sum of active estimate rows (`is_estimate=true`) — the hold / ceiling. `"0"` when none. */
  authorizedUsd: string;
  /** Sum of active actual rows (`is_estimate=false`) — settled so far. `"0"` when none. */
  capturedUsd: string;
  /** Settlement progress over the node's active rows. */
  settleState: SettleState;
}

/**
 * One event forwarded by a Sapiom capability a step dispatched (step-events),
 * ordered by `sourceId` then `sequence`. Populated at completion for dispatched
 * agent steps today; live mid-run events require the agent→engine streaming
 * seam. Absence is honest, not broken.
 */
export interface StepEvent {
  /** The emitting capability's id (e.g. the coding run id). */
  sourceId: string;
  /** Source-local monotonic sequence (1-indexed per source). */
  sequence: number;
  /** Event kind — `tool_use`, `thinking`, `result`, `log`, … */
  kind: string;
  /** The event body, verbatim. */
  payload: Record<string, unknown>;
  /** Source-reported event time (ISO-8601) when known; else null. */
  eventTs: string | null;
}

/**
 * Structured terminal error for a failed step. `trace` is source-mapped to the
 * authored TypeScript (not the compiled `.mjs`); when no stack was captured,
 * `trace` is null and `traceUnavailableReason` records WHY — a recorded reason
 * is a fact, never a blank panel.
 */
export interface StepError {
  /** The error message. */
  message: string;
  /** Source-mapped stack trace; null when none was captured (see `traceUnavailableReason`). */
  trace: string | null;
  /** Why no stack trace exists — non-null only when `trace` is null; never blank. */
  traceUnavailableReason: string | null;
}

/**
 * A lightweight reference to an execution in the dispatch tree — used both for
 * a run's `children` and as the `listExecutions()` element. Trace-keyed so a
 * node can be placed in its tree without a second read.
 */
export interface ExecutionRef {
  /** The referenced execution id. */
  executionId: string;
  /** The root of the dispatch tree this execution belongs to. */
  traceRoot: string;
  /** Display name of the execution. */
  name: string;
  /** Lifecycle status of the execution. */
  status: string;
}

/**
 * A typed edge from a step to the child execution it dispatched — assembled
 * from the dispatch ledger, NOT string-sniffed from a signal correlation id.
 * Present on a step only when that step launched a child run.
 */
export interface DispatchRef {
  /** The dispatch ledger row id. */
  dispatchId: string;
  /** The dispatched child execution id. */
  childExecutionId: string;
  /** Structured resource type of the target — `'orchestration'` today (later `'coding'`, …). */
  targetType: string;
  /** Dispatch lifecycle: `'pending'` at launch, `'resolved'` when the result lands. */
  status: string;
  /** The signal correlation id the parent resumes on. */
  correlationId: string;
}

/**
 * One step-attempt in the audit trail, with per-step cost, trace identity,
 * typed dispatch edge, and structured error. Ordered by `stepOrder` ascending
 * inside {@link ExecutionProjection.steps}.
 */
export interface StepProjection {
  stepName: string;
  stepOrder: number;
  attempt: number;
  status: string;
  /** OTel span id for this step's leg; nests under the run's `traceId`. Null pre-span. */
  spanId: string | null;
  /** ISO-8601 start; null if the attempt never started. */
  startedAt: string | null;
  /** ISO-8601 finish; null while running. `duration = finishedAt - startedAt`. */
  finishedAt: string | null;
  /** Input passed to this step attempt. */
  input: unknown;
  /** Output the step returned (null on throw). */
  output: unknown;
  /** Snapshot of `ctx.shared` at the moment this step resolved or threw. */
  sharedStateAfter: Record<string, unknown> | null;
  /** Directive the step returned (continue / retry / pause / terminate / fail). Null on throw. */
  nextDirective: unknown;
  /** Per-step capability cost — authorized vs captured, never collapsed. */
  cost: CostNode;
  /** Executor-side log buffer for dispatched attempts; null for in-process steps. */
  logs: string | null;
  /** Events forwarded by capabilities this step dispatched; empty when none. */
  events: StepEvent[];
  /** Structured error if the step threw; null on success. */
  error: StepError | null;
  /** The child run this step dispatched; null for in-process steps. */
  dispatch: DispatchRef | null;
}

/**
 * The canonical inspection projection for a single execution — the same tree +
 * per-node cost + trace identity the REST `ExecutionProjection` returns (Module
 * P / SAP-1138). One read returns everything a view needs. Extension of the
 * engine execution detail: the base audit fields plus the tree/cost/trace
 * projection additions.
 */
export interface ExecutionProjection {
  // ── identity / status ──────────────────────────────────────────────────────
  id: string;
  name: string;
  organizationId: string | null;
  tenantId: string | null;
  status: string;
  currentStep: string | null;
  currentStepAttempt: number;
  version: number;
  /** The definition this run belongs to; null for pre-M3e executions. */
  definitionId: string | null;
  /** The build-run (version / commit sha) active when this run executed; null pre-M3e. */
  buildRunId: string | null;
  idempotencyKey: string | null;
  pausedSignalName: string | null;
  pausedSignalCorrelationId: string | null;
  pausedUntil: string | null;
  startedAt: string;
  finishedAt: string | null;

  // ── heavy detail (full audit read) ───────────────────────────────────────────
  /** The input passed to the entry step. */
  input: unknown;
  /** Latest snapshot of `ctx.shared` from the execution row. */
  sharedState: Record<string, unknown>;
  /** Final output (only set when status=completed). */
  output: unknown;
  /** Terminal error (only set when status=failed or cancelled). */
  error: unknown;
  /** JSON Schema of the resume step's input while paused; null otherwise. */
  pausedStepInputSchema: Record<string, unknown> | null;
  /** A runnable prefill for the resume payload editor. */
  pausedStepInputExample: unknown;

  // ── tree / identity (trace-keyed; lineage asserts into these) ────────────────
  /** The root of this run's dispatch tree; `rootExecutionId` is an alias. Falls back to `id` pre-lineage. */
  traceRoot: string;
  /** Alias of {@link traceRoot} — the engine's denormalized tree root. */
  rootExecutionId: string;
  /** The execution that dispatched this run; `parentExecutionId` is an alias. Null for a top-level run. */
  traceParent: string | null;
  /** Alias of {@link traceParent} — the dispatching parent from engine lineage. */
  parentExecutionId: string | null;
  /** Core trace id for this run; every step's `spanId` nests under it. Null pre-spine. */
  traceId: string | null;
  /** Typed child edges of this run's dispatch tree — the authoritative full edge set. Empty for a leaf. */
  children: ExecutionRef[];

  // ── cost (run-level rollup over the tree; never collapsed) ───────────────────
  cost: CostNode;

  // ── steps ────────────────────────────────────────────────────────────────────
  steps: StepProjection[];
}
