/**
 * Tolerant decode of the REST execution read into the canonical
 * {@link ExecutionProjection}. The SDK does NOT recompute cost — it normalizes a
 * raw JSON body into a well-typed projection so consumers never branch on a
 * missing field, and it degrades HONESTLY rather than fabricating data.
 *
 * Graceful degradation (mirrors how the REST DTO degrades on older executions):
 *   - Pre-seam runs with no `traceParent`/lineage → tree derived from the run's
 *     own id (`traceRoot = rootExecutionId = id`, `traceParent = null`).
 *   - Missing cost → `null` (honest absence), NEVER a fabricated `$0`. The
 *     execution-detail endpoint is cost-agnostic; cost is served separately at
 *     `/executions/:id/spend`. A caller sees `cost: null` and knows to look
 *     there, instead of reading a misleading zero.
 *   - Missing step arrays/fields → empty arrays / nulls, never a throw.
 *
 * The `decode*` helpers below are intentionally NOT part of the package's public
 * API (only {@link decodeExecutionProjection} is re-exported from `index.ts`, as
 * the reusable entry point tickets 2/4 need to re-decode a body after an SSE
 * refetch). The finer-grained helpers stay module-internal.
 */
import type {
  CostNode,
  DispatchRef,
  ExecutionProjection,
  ExecutionRef,
  SettleState,
  StepError,
  StepErrorFrame,
  StepErrorTrace,
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

const SETTLE_STATES: readonly SettleState[] = ["pending", "settling", "final"];

function settleState(v: unknown): SettleState {
  return typeof v === "string" && (SETTLE_STATES as readonly string[]).includes(v)
    ? (v as SettleState)
    : "final";
}

/**
 * Normalize a raw cost blob into a {@link CostNode}, or `null` when absent. A
 * null/missing cost is honest absence — NOT a fabricated `$0` — so a caller
 * distinguishes "no cost data on this read" from "genuinely zero". Authorized
 * and captured stay distinct legs when present.
 */
export function decodeCostNode(raw: unknown): CostNode | null {
  if (!isRecord(raw)) return null;
  return {
    authorizedUsd: str("0", raw.authorizedUsd),
    capturedUsd: str("0", raw.capturedUsd),
    settleState: settleState(raw.settleState),
  };
}

function decodeStepErrorFrame(raw: unknown): StepErrorFrame {
  const r = rec(raw);
  const frame: StepErrorFrame = {};
  if (typeof r.function === "string") frame.function = r.function;
  if (typeof r.file === "string") frame.file = r.file;
  if (typeof r.line === "number") frame.line = r.line;
  if (typeof r.column === "number") frame.column = r.column;
  return frame;
}

/**
 * Decode the structured stack trace. Accepts the wire's structured object
 * (`{ frames, sourceMapped, raw }`), a bare stack string (→ `{ frames: [],
 * sourceMapped: false, raw }`), or null. Preserves the source-mapped frames so
 * the SDK doesn't drop the whole trace feature.
 */
function decodeStepErrorTrace(raw: unknown): StepErrorTrace | null {
  if (typeof raw === "string") {
    return { frames: [], sourceMapped: false, raw };
  }
  if (!isRecord(raw)) return null;
  const trace: StepErrorTrace = {
    frames: Array.isArray(raw.frames) ? raw.frames.map(decodeStepErrorFrame) : [],
    sourceMapped: raw.sourceMapped === true,
  };
  if (typeof raw.raw === "string") trace.raw = raw.raw;
  return trace;
}

function decodeStepError(raw: unknown): StepError | null {
  if (!isRecord(raw)) return null;
  // A raw error may be a `{ message, trace, traceUnavailableReason }` (wire), or
  // a legacy `{ message, stack }` — take the message, the structured trace, and
  // the recorded reason a trace is missing.
  const message = strOrNull(raw.message);
  if (message === null) return null;
  return {
    message,
    trace: decodeStepErrorTrace(raw.trace ?? raw.stack ?? null),
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
    // The wire dispatch edge keys the child by `target_id`; accept the canonical
    // `childExecutionId` / a run-level `executionId` too, so any edge decodes.
    childExecutionId: str("", raw.childExecutionId, raw.targetId, raw.executionId),
    targetType: str("", raw.targetType),
    correlationId: str("", raw.correlationId),
    status: str("", raw.status),
  };
}

/**
 * Decode one execution reference (a `children` edge or a `listExecutions` row).
 * `traceRoot` falls back to the ref's own id when lineage is absent, and the id
 * degrades across the id field names different endpoints use. `name` is `""`
 * when the source (e.g. a child edge) omits it — see {@link ExecutionRef}.
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
    logs: r.logs ?? null,
    events: Array.isArray(r.events) ? r.events.map(decodeStepEvent) : [],
    error: decodeStepError(r.error),
    dispatch: decodeDispatchRef(r.dispatch),
  };
}

// ── top-level decoder ──────────────────────────────────────────────────────────

/**
 * Normalize a raw REST body into a complete {@link ExecutionProjection}. Never
 * throws on a well-formed-but-degraded body: pre-seam runs get a tree derived
 * from their own id, and an absent cost decodes to `null` (honest absence, not a
 * fabricated `$0`). This is the reusable entry point tickets 2/4 use to re-decode
 * a projection body after an SSE-triggered refetch.
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
