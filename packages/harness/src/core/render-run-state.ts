/**
 * renderRunState — the ONE pure mapper from a decoded {@link ExecutionProjection}
 * to the canvas's {@link RunView} render state.
 *
 * Pure and deterministic: no LLM, no I/O, no clock. Every field is derived from
 * the decoded projection, so the same function drives the polling path today and
 * a future WebSocket push (only the data source swaps, never this mapping). Cost
 * and latency are read straight from the projection and rendered statically — the
 * LLM is only ever invoked later by an explicit debug-macro press, never to
 * compute what's shown here.
 *
 * Honest absence is preserved end to end: a step with no cost on this read gets
 * no `costUsd` (not `0`), a still-running step gets no `latencyMs`, and a step
 * with no logs gets no `logSlice` — matching the SDK's "null cost is honest
 * absence, never a fabricated $0" contract.
 */
import { isExecutionTerminal } from "@sapiom/agent-core";
import type {
  CostNode,
  ExecutionProjection,
  StepProjection,
} from "@sapiom/agent-core";

import type { RunView, StepStatus, StepView } from "../shared/types.js";

/**
 * Cap on the characters of a step's executor log buffer surfaced in `logSlice`.
 * The TAIL is kept (most recent lines) because failures surface at the end of a
 * log. This is a payload guard on the poll response; the debug-macro context
 * extractor does the final, smaller trim for prompt injection.
 */
const LOG_SLICE_MAX = 4000;

/**
 * Fold the run's lifecycle status into the four states the UI distinguishes.
 * Reuses `isExecutionTerminal` (agent-core's single source of truth for "won't
 * advance on its own") so a newly-added terminal status can never be misdrawn as
 * still-running: anything non-terminal (running, paused, queued, unknown) is
 * `running`; the terminal set normalizes `canceled` → `cancelled`.
 */
function toRunStatus(raw: string): RunView["status"] {
  if (!isExecutionTerminal(raw)) return "running";
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  return "cancelled"; // the only remaining terminal statuses: "cancelled" / "canceled"
}

/**
 * Fold a step's raw status into a {@link StepStatus}. Handles the real engine
 * vocabulary (`succeeded`/`threw` from prod agents surface) plus the earlier
 * values (`completed`/`failed`/`cancelled`/`canceled`). A cancelled or threw
 * step folds to `failed` (it did not pass — mirrors run-local.ts); anything
 * not yet running/passed/failed is `pending` (unstarted, queued, or unknown).
 */
function toStepStatus(raw: string): StepStatus {
  if (raw === "completed" || raw === "succeeded") return "passed";
  if (
    raw === "failed" ||
    raw === "threw" ||
    raw === "cancelled" ||
    raw === "canceled"
  )
    return "failed";
  if (raw === "running") return "running";
  return "pending";
}

/** Captured USD as a number; `undefined` on honest absence (null cost) or an
 *  unparseable amount — never a fabricated `0`. */
function toCostUsd(cost: CostNode | null): number | undefined {
  if (!cost) return undefined;
  const n = Number(cost.capturedUsd);
  return Number.isFinite(n) ? n : undefined;
}

/** `finishedAt − startedAt` in ms; `undefined` while still running (no finish)
 *  or when either timestamp is unparseable. A negative delta (clock skew) is
 *  dropped rather than shown as a misleading negative latency. */
function toLatencyMs(
  startedAt: string | null,
  finishedAt: string | null,
): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const delta = end - start;
  return delta >= 0 ? delta : undefined;
}

/** One executor log entry → a compact line. Accepts the `{ ts, level, msg }`
 *  wire shape (or `message`), a bare string, or anything else (stringified). */
function formatLogEntry(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    const e = entry as {
      ts?: unknown;
      level?: unknown;
      msg?: unknown;
      message?: unknown;
    };
    const parts = [e.ts, e.level, e.msg ?? e.message].filter(
      (p): p is string | number =>
        typeof p === "string" || typeof p === "number",
    );
    if (parts.length > 0) return parts.map(String).join(" ");
  }
  return String(entry);
}

/** Format the executor log buffer into a trimmed, tail-preserving slice, or
 *  `undefined` when there are no usable logs. */
function toLogSlice(logs: unknown): string | undefined {
  if (!Array.isArray(logs) || logs.length === 0) return undefined;
  const text = logs.map(formatLogEntry).join("\n").trim();
  if (text === "") return undefined;
  return text.length > LOG_SLICE_MAX
    ? text.slice(text.length - LOG_SLICE_MAX)
    : text;
}

/** Map one projection step to its render view. Optional fields are assigned only
 *  when present so absence stays absent (not `undefined`) in the JSON payload. */
function toStepView(step: StepProjection): StepView {
  const view: StepView = {
    id: step.spanId ?? `step-${step.stepOrder}-${step.attempt}`,
    name: step.stepName,
    status: toStepStatus(step.status),
  };
  const costUsd = toCostUsd(step.cost);
  if (costUsd !== undefined) view.costUsd = costUsd;
  const latencyMs = toLatencyMs(step.startedAt, step.finishedAt);
  if (latencyMs !== undefined) view.latencyMs = latencyMs;
  if (step.error?.message) view.error = step.error.message;
  const logSlice = toLogSlice(step.logs);
  if (logSlice !== undefined) view.logSlice = logSlice;
  return view;
}

/**
 * Map a decoded {@link ExecutionProjection} to the {@link RunView} the canvas
 * renders. Order-preserving over `steps`; total (never throws) because the
 * projection is already the decoded, degradation-tolerant shape.
 */
export function renderRunState(decoded: ExecutionProjection): RunView {
  return {
    executionId: decoded.id,
    status: toRunStatus(decoded.status),
    steps: decoded.steps.map(toStepView),
  };
}
