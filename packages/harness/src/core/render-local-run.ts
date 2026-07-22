/**
 * renderLocalRun — the pure mapper from an offline stub run's per-step traces
 * ({@link LocalStepTrace}[], streamed as NDJSON by `POST /api/runs/local`) to
 * the same {@link RunView} the canvas renders for prod runs. Its twin is
 * {@link renderRunState} (prod / local-backend); both emit the identical
 * cost-free {@link StepView} shape, so ONE inspector renders every run source.
 *
 * Pure and deterministic: no LLM, no I/O, no clock. Every field is derived from
 * the traces (plus the caller-supplied execution id and terminal outcome), so
 * the same function can map a partial trace mid-stream and the final trace at
 * the end — only the input grows, never this mapping. It is a Stryker target;
 * the tests are mutation-first.
 *
 * Honest absence, matching renderRunState and the SDK's "null is honest absence,
 * never a fabricated value" contract:
 *  - **No cost** — local runs are stubbed and free by construction; a StepView
 *    from here never carries `costUsd` (so the inspector reads "local run ·
 *    free", never "$0.00").
 *  - **No latency** — a {@link LocalStepTrace} carries no timing (agent-core's
 *    in-process dispatcher records none, and agent-core is consumed as-is), so
 *    `latencyMs` is ABSENT rather than a fabricated `0`.
 *  - **Output** is present only when the trace captured one (a step that threw,
 *    or a `continue` with no value, carries none) — but ABSENCE is `undefined`
 *    on the trace, and a genuine `null`/`false`/`0`/`""` output is a real value
 *    that passes through.
 *  - **Input** is always carried by a trace (every attempt ran on some input,
 *    even `undefined`); it is surfaced whenever it isn't `undefined`.
 *  - **Logs and errors** collapse to the same `logSlice`/`error` fields prod
 *    uses, via the shared formatter.
 *  - **Stub signal (WB15-2)** is RUN-LEVEL. A local run is stub-served by
 *    construction, so the run carries `stubbed: true` (prod's renderRunState
 *    never does) and the inspector marks each executed step with a "stubbed"
 *    chip — agent-core records no per-CALL stub attribution, so that is the
 *    honest granularity. The terminal summary's `unusedStubs` (a supplied key
 *    that matched nothing) and `stubWarnings` (a wrong-shape value) pass through
 *    only when NON-empty, so a clean run surfaces no notice at all.
 */
import type { LocalStepTrace, LocalRunOutcome } from "@sapiom/agent-core";

import type {
  RunView,
  StepStatus,
  StepView,
  UnusedStubView,
} from "../shared/types.js";
// Reuse prod's exact log-buffer formatter so a step's `logSlice` is byte-
// identical whether it came from a prod projection or a local trace — the
// inspector can never disagree with itself about how a log renders. Imported
// from the dependency-free module (NOT render-run-state) so this mapper carries
// no `@sapiom/agent-core`/`node:fs` runtime dep into the browser bundle.
import { toLogSlice } from "./render-log-slice.js";

/**
 * Options carrying the run-level facts a `LocalStepTrace[]` alone can't provide.
 * Both are optional so the mapper can render a live, still-streaming trace (no
 * terminal summary yet) exactly as it renders the final one.
 */
export interface RenderLocalRunOptions {
  /**
   * The execution id to stamp on the {@link RunView}. A local run has no
   * server-issued id, so the caller (the SPA's run store) synthesizes and owns
   * one; the mapper stays pure by taking it rather than minting time/randomness.
   * Defaults to an empty string when the caller has none yet.
   */
  executionId?: string;
  /**
   * The run's terminal outcome from the NDJSON summary line, when it has
   * arrived. Absent while the stream is still open — the mapper then reports the
   * run as `running` (steps may still be coming). Passing it flips the run to
   * its settled status.
   */
  outcome?: LocalRunOutcome;
  /**
   * Supplied stub keys that matched no capability call this run — from the
   * terminal summary line. A no-op mock (typo'd path, wrong plural/singular)
   * otherwise fails silently; surfacing it is the whole point of WB15-2. Only a
   * NON-empty list reaches the {@link RunView} (honest absence), so pass it as-is
   * from the summary and the mapper decides. Absent while the stream is open.
   */
  unusedStubs?: UnusedStubView[];
  /**
   * Warnings about stub values that matched a key but carried the wrong shape —
   * from the terminal summary line. Same honest-absence handling as
   * {@link RenderLocalRunOptions.unusedStubs}: an empty list is dropped.
   */
  stubWarnings?: string[];
}

/**
 * Fold a single step-attempt's status into a {@link StepStatus}. A local trace's
 * status vocabulary is exactly `succeeded | threw` (see agent-core's
 * LocalStubDispatcher). `succeeded` → `passed`; `threw` → `failed` (it did not
 * pass — mirrors renderRunState's fold of `threw`). Anything unrecognized is
 * `pending` (defensive; the union shouldn't produce it), NEVER silently
 * `passed`.
 */
function toStepStatus(raw: LocalStepTrace["status"]): StepStatus {
  if (raw === "succeeded") return "passed";
  if (raw === "threw") return "failed";
  return "pending";
}

/**
 * Fold the run's terminal outcome into the four states the UI draws. A local run
 * that `paused` is not yet done (the auto-resume loop or a human must advance
 * it), so it reads as `running`, not a terminal state. An absent outcome (stream
 * still open) is also `running`. `completed`/`failed` map straight through;
 * there is no local "cancelled" outcome.
 */
function toRunStatus(outcome: LocalRunOutcome | undefined): RunView["status"] {
  if (outcome === "completed") return "completed";
  if (outcome === "failed") return "failed";
  // "paused", "running", or absent (still streaming) — not terminal.
  return "running";
}

/**
 * Map one trace line to its {@link StepView}. Optional fields are assigned only
 * when they carry a real value, so honest absence survives into the JSON the
 * inspector reads (a missing field renders nothing rather than a fabricated
 * zero/empty payload).
 */
function toStepView(trace: LocalStepTrace): StepView {
  const view: StepView = {
    // Local traces have no OTel span id; the (step, attempt) pair is the stable,
    // collision-free key across a run's attempts of the same step.
    id: `${trace.step}-${trace.attempt}`,
    name: trace.step,
    status: toStepStatus(trace.status),
  };
  // No costUsd, no latencyMs — a local run is free and untimed (see the file
  // header). Their honest absence is the whole point of the local target.
  if (trace.input !== undefined) view.input = trace.input;
  if (trace.output !== undefined) view.output = trace.output;
  if (trace.error?.message) view.error = trace.error.message;
  const logSlice = toLogSlice(trace.logs);
  if (logSlice !== undefined) view.logSlice = logSlice;
  return view;
}

/**
 * Map an offline stub run's traces (plus the caller-owned execution id and, once
 * known, terminal outcome) to the {@link RunView} the canvas renders. Order-
 * preserving over `traces` (execution order); total — never throws, mirroring
 * renderRunState — because the traces are already the decoded wire shape.
 */
export function renderLocalRun(
  traces: LocalStepTrace[],
  options: RenderLocalRunOptions = {},
): RunView {
  const view: RunView = {
    executionId: options.executionId ?? "",
    status: toRunStatus(options.outcome),
    steps: traces.map(toStepView),
    // A local run is stub-served by construction (every ctx.sapiom.* call
    // resolves from a stub, never the network) — so the run itself is `stubbed`,
    // and the inspector marks each executed step with the chip. This is the
    // honest per-run truth: agent-core records no per-CALL stub attribution, so
    // there is nothing finer to claim. renderRunState (prod) never sets this.
    stubbed: true,
  };
  // Honest absence: only a NON-empty signal reaches the view, so the read-only
  // notice renders nothing when the run had no stub-hygiene problems. A supplied
  // empty array is indistinguishable from "no problems" and must not surface.
  if (options.unusedStubs && options.unusedStubs.length > 0) {
    view.unusedStubs = options.unusedStubs;
  }
  if (options.stubWarnings && options.stubWarnings.length > 0) {
    view.stubWarnings = options.stubWarnings;
  }
  return view;
}
