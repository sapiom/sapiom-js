/**
 * renderRunState — the ONE pure mapper from a decoded {@link ExecutionProjection}
 * to the canvas's {@link RunView} render state.
 *
 * Pure and deterministic: no LLM, no I/O, no clock. Every field is derived from
 * the decoded projection, so the same function drives the polling path today and
 * a future WebSocket push (only the data source swaps, never this mapping).
 * Latency is read straight from the projection and rendered statically — the
 * LLM is only ever invoked later by an explicit debug-macro press, never to
 * compute what's shown here.
 *
 * Honest absence is preserved end to end: a still-running step gets no
 * `latencyMs`, and a step with no logs gets no `logSlice`. The inspector
 * surfaces logs, latency, and pass/fail only — no cost.
 */
import { isExecutionTerminal } from "@sapiom/agent-core";
import type {
  ExecutionProjection,
  StepProjection,
} from "@sapiom/agent-core";

import type { RunView, StepStatus, StepView } from "../shared/types.js";
// The log-buffer formatter lives in its own dependency-free module so the
// local-run mapper (imported by the browser SPA) can share the SAME formatter
// WITHOUT dragging this file's `@sapiom/agent-core` runtime import — and its
// `node:fs` reach — into the web bundle.
import { toLogSlice } from "./render-log-slice.js";

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

/** Map one projection step to its render view. Optional fields are assigned only
 *  when present so absence stays absent (not `undefined`) in the JSON payload. */
function toStepView(step: StepProjection): StepView {
  const view: StepView = {
    id: step.spanId ?? `step-${step.stepOrder}-${step.attempt}`,
    name: step.stepName,
    status: toStepStatus(step.status),
  };
  const latencyMs = toLatencyMs(step.startedAt, step.finishedAt);
  if (latencyMs !== undefined) view.latencyMs = latencyMs;
  if (step.error?.message) view.error = step.error.message;
  const logSlice = toLogSlice(step.logs);
  if (logSlice !== undefined) view.logSlice = logSlice;
  // Real per-step IO for the inspector's "Last run" block. The decoder
  // collapses an absent input/output to `null` (its absence sentinel), so a
  // `null` here means "the read carried nothing" — surfaced as ABSENT, never a
  // fabricated payload. Any non-null value (including `0`, `false`, `""`) is a
  // real payload and passes through. Capability, not model: these are the
  // step's own values, with no provider/model surfaced.
  if (step.input !== null) view.input = step.input;
  if (step.output !== null) view.output = step.output;
  // `step.events` are capability execution events forwarded by dispatched
  // capabilities (e.g. tool_use / thinking / result events from a coding run).
  // They do NOT represent dotted workflow capability calls (search.webSearch,
  // memory.append, etc.) with args/results in the StepCall format, so we
  // cannot map them to StepView.calls without fabricating structure that isn't
  // there. `calls` is left absent for prod steps. The inspector's
  // input/output/logs already carry the step-level evidence for prod runs;
  // per-call detail is a fast-follow that requires a server-side addition to
  // the projection shape (emitting dotted-capability call records alongside
  // their args/results at the step level).
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
