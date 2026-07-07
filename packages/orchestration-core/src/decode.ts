/**
 * Tolerant decode of the REST execution read into the canonical
 * {@link ExecutionProjection}. The SDK is a thin passthrough of the REST shape
 * — this does NOT reshape or recompute cost, it only NORMALIZES a raw JSON body
 * into a fully-populated projection so consumers never branch on missing fields.
 *
 * Graceful degradation (mirrors how the REST DTO degrades on older executions):
 *   - Pre-seam runs with no `traceParent`/lineage → tree derived from the run's
 *     own id (`traceRoot = rootExecutionId = id`, `traceParent = null`).
 *   - Missing per-node cost → a zeroed {@link CostNode} (flat fallback), so
 *     every node still exposes `authorizedUsd`/`capturedUsd`/`settleState` and
 *     the two legs are never collapsed.
 *   - Missing step arrays/fields → empty arrays / nulls, never a throw.
 */
import type {
  CostNode,
  DispatchRef,
  ExecutionProjection,
  ExecutionRef,
  SettleState,
  StepError,
  StepEvent,
  StepProjection,
} from "./types.js";

// ── primitive coercers ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/** First defined string among the candidates, else `fallback`. */
function str(fallback: string, ...candidates: unknown[]): string {
  for (const c of candidates) if (typeof c === "string") return c;
  return fallback;
}

/** First defined string among the candidates, else null. */
function strOrNull(...candidates: unknown[]): string | null {
  for (const c of candidates) if (typeof c === "string") return c;
  return null;
}

function numOr(fallback: number, v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function recordOrNull(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

// ── node decoders ────────────────────────────────────────────────────────────

const ZERO_COST: CostNode = {
  authorizedUsd: "0",
  capturedUsd: "0",
  settleState: "final",
};

const SETTLE_STATES: readonly SettleState[] = ["pending", "settling", "final"];

function settleState(v: unknown): SettleState {
  return typeof v === "string" && (SETTLE_STATES as readonly string[]).includes(v)
    ? (v as SettleState)
    : "final";
}

/**
 * Normalize a raw cost blob into a complete {@link CostNode}. A null/absent
 * cost (the common uncosted run) becomes a zeroed node rather than a fabricated
 * single number — authorized and captured stay distinct legs.
 */
export function decodeCostNode(raw: unknown): CostNode {
  if (!isRecord(raw)) return { ...ZERO_COST };
  return {
    authorizedUsd: str("0", raw.authorizedUsd),
    capturedUsd: str("0", raw.capturedUsd),
    settleState: settleState(raw.settleState),
  };
}

function decodeStepError(raw: unknown): StepError | null {
  if (!isRecord(raw)) return null;
  // A raw error may be a plain `{ message }`, a structured StepError, or a
  // legacy `{ message, stack }` — take the message, source-mapped trace string
  // when present, and record why a trace is missing when the field is set.
  const message = strOrNull(raw.message);
  if (message === null) return null;
  return {
    message,
    trace: strOrNull(raw.trace, raw.stack),
    traceUnavailableReason: strOrNull(raw.traceUnavailableReason),
  };
}

function decodeStepEvent(raw: unknown): StepEvent {
  const r = rec(raw);
  return {
    sourceId: str("", r.sourceId),
    sequence: numOr(0, r.sequence),
    kind: str("", r.kind),
    payload: recordOrNull(r.payload) ?? {},
    eventTs: strOrNull(r.eventTs),
  };
}

function decodeDispatchRef(raw: unknown): DispatchRef | null {
  if (!isRecord(raw)) return null;
  return {
    // Accept the canonical `dispatchId`/`childExecutionId`, degrading to the
    // engine's `id`/`targetId` ledger names so an older body still decodes.
    dispatchId: str("", raw.dispatchId, raw.id),
    childExecutionId: str("", raw.childExecutionId, raw.targetId, raw.executionId),
    targetType: str("", raw.targetType),
    status: str("", raw.status),
    correlationId: str("", raw.correlationId),
  };
}

/**
 * Decode one execution reference (a `children` edge or a `listExecutions` row).
 * `traceRoot` falls back to the ref's own id when lineage is absent, and the id
 * degrades across the id field names different endpoints use.
 */
export function decodeExecutionRef(raw: unknown): ExecutionRef {
  const r = rec(raw);
  const executionId = str("", r.executionId, r.id);
  return {
    executionId,
    traceRoot: str(executionId, r.traceRoot, r.rootExecutionId),
    name: str("", r.name),
    status: str("", r.status),
  };
}

function decodeStep(raw: unknown): StepProjection {
  const r = rec(raw);
  return {
    stepName: str("", r.stepName),
    stepOrder: numOr(0, r.stepOrder),
    attempt: numOr(0, r.attempt),
    status: str("", r.status),
    spanId: strOrNull(r.spanId),
    startedAt: strOrNull(r.startedAt),
    finishedAt: strOrNull(r.finishedAt),
    input: r.input ?? null,
    output: r.output ?? null,
    sharedStateAfter: recordOrNull(r.sharedStateAfter),
    nextDirective: r.nextDirective ?? null,
    cost: decodeCostNode(r.cost),
    logs: strOrNull(r.logs),
    events: Array.isArray(r.events) ? r.events.map(decodeStepEvent) : [],
    error: decodeStepError(r.error),
    dispatch: decodeDispatchRef(r.dispatch),
  };
}

// ── top-level decoder ──────────────────────────────────────────────────────────

/**
 * Normalize a raw REST body into a complete {@link ExecutionProjection}. Never
 * throws on a well-formed-but-degraded body: pre-seam runs get a tree derived
 * from their own id and a flat (zeroed) cost fallback.
 */
export function decodeExecutionProjection(raw: unknown): ExecutionProjection {
  const r = rec(raw);
  const id = str("", r.id, r.executionId);
  // Lineage degrades to self: a pre-seam row with no root/parent is its own
  // single-node tree, so the tree always has exactly one root (itself).
  const traceRoot = str(id, r.traceRoot, r.rootExecutionId);
  const traceParent = strOrNull(r.traceParent, r.parentExecutionId);

  return {
    id,
    name: str("", r.name),
    organizationId: strOrNull(r.organizationId),
    tenantId: strOrNull(r.tenantId),
    status: str("", r.status),
    currentStep: strOrNull(r.currentStep),
    currentStepAttempt: numOr(0, r.currentStepAttempt),
    version: numOr(0, r.version),
    definitionId: strOrNull(r.definitionId),
    buildRunId: strOrNull(r.buildRunId),
    idempotencyKey: strOrNull(r.idempotencyKey),
    pausedSignalName: strOrNull(r.pausedSignalName),
    pausedSignalCorrelationId: strOrNull(r.pausedSignalCorrelationId),
    pausedUntil: strOrNull(r.pausedUntil),
    startedAt: str("", r.startedAt),
    finishedAt: strOrNull(r.finishedAt),

    input: r.input ?? null,
    sharedState: recordOrNull(r.sharedState) ?? {},
    output: r.output ?? null,
    error: r.error ?? null,
    pausedStepInputSchema: recordOrNull(r.pausedStepInputSchema),
    pausedStepInputExample: r.pausedStepInputExample ?? null,

    traceRoot,
    rootExecutionId: str(traceRoot, r.rootExecutionId, r.traceRoot),
    traceParent,
    parentExecutionId: strOrNull(r.parentExecutionId, r.traceParent),
    traceId: strOrNull(r.traceId),
    children: Array.isArray(r.children) ? r.children.map(decodeExecutionRef) : [],

    cost: decodeCostNode(r.cost),

    steps: Array.isArray(r.steps) ? r.steps.map(decodeStep) : [],
  };
}
