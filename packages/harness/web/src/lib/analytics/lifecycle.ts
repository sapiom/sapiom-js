import type { LocalRunOutcome } from "@sapiom/agent-core";
import type { RunView, WorkflowInfo } from "@shared/types";

/**
 * Pure helpers behind the agent-lifecycle product events (`agent.created`,
 * `agent.deploy_*`). Kept framework- and PostHog-free so the App effect / store
 * stay thin wrappers and the counting logic is unit-testable in Node.
 *
 * Privacy: a slug is a folder name or a deployed slug — NEVER the absolute
 * path, which would leak the user's directory layout. See analytics/events.ts.
 */

/**
 * The last path segment — the low-cardinality slug we attach as `workflow_slug`
 * instead of the absolute path. Tolerant of either separator and trailing
 * slashes; falls back to the input if there is nothing to slice.
 */
export function slugFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The paths present in `workflows` that are not yet in `seen` — the agents that
 * have newly appeared since the last snapshot. The caller seeds `seen` on first
 * load (so pre-existing agents never count) and adds the returned paths after
 * emitting, so each agent is counted exactly once per app run.
 */
export function newAgentPaths(
  seen: ReadonlySet<string>,
  workflows: readonly Pick<WorkflowInfo, "path">[],
): string[] {
  const fresh: string[] = [];
  for (const w of workflows) {
    if (!seen.has(w.path)) fresh.push(w.path);
  }
  return fresh;
}

/**
 * A coarse, message-free failure enum for `agent.deploy_failed`. A deploy fails
 * either while creating the remote agent (`linking`) or while building it
 * (`building`); an error thrown out of the stream (network, etc.) is
 * `exception`. Never a raw message — the privacy rule forbids it.
 */
export function deployErrorKind(
  lastNonTerminalPhase: "linking" | "building" | null,
  isException: boolean,
): "link_failed" | "build_failed" | "exception" {
  if (isException) return "exception";
  return lastNonTerminalPhase === "linking" ? "link_failed" : "build_failed";
}

/**
 * A coarse, message-free failure enum for `agent.run_failed`, mirroring
 * {@link deployErrorKind}:
 *
 *  - `failed` — the executor returned a terminal unsuccessful status.
 *  - `cancelled` — stopped by the user or the server.
 *  - `exception` — we were watching a live run and lost it: the local stream
 *    threw, or the prod poller started failing partway through.
 *  - `unobservable` — we never saw the run at all, because the very first poll
 *    failed. Almost always a harness server too old to serve
 *    `/api/runs/:id/state`, NOT a run that went wrong.
 *
 * `unobservable` exists so that bucket is labelled instead of hidden. Every
 * `agent.run_started` should be followed by exactly one terminal event, and
 * folding "old server" into `failed` would put a step change in the failure
 * rate every time an old CLI is in the mix. The one deliberate exception to
 * that balance is a local run that ends `paused` — see
 * {@link localRunOutcomeKind}.
 */
export type RunErrorKind = "failed" | "cancelled" | "exception" | "unobservable";

/**
 * Map a terminal {@link RunView.status} onto {@link RunErrorKind}. Only the
 * unsuccessful statuses reach here; `completed` is a success and `running` is
 * not terminal, so both collapse to `failed` rather than inventing a bucket —
 * a wrong call site should show up as an implausible `failed`, not as a new
 * enum value nobody's dashboard knows about.
 */
export function runErrorKind(status: RunView["status"]): RunErrorKind {
  return status === "cancelled" ? "cancelled" : "failed";
}

/**
 * Classify how a local run ended, for the run funnel.
 *
 * `LocalRunOutcome` is not all-terminal: `paused` (the agent is waiting on a
 * signal) and `running` mean the run has not finished, and `undefined` means
 * the stream ended without ever sending its summary line. None of those are
 * outcomes, so they map to `pending` and the caller emits nothing — counting a
 * paused run as failed would understate the success rate by exactly the number
 * of agents that use signals.
 *
 * `exception` is deliberately NOT reachable from here: it describes the
 * transport breaking, which the caller knows about and this value doesn't.
 */
export function localRunOutcomeKind(
  outcome: LocalRunOutcome | undefined,
): "succeeded" | "failed" | "pending" {
  if (outcome === "completed") return "succeeded";
  if (outcome === "failed") return "failed";
  return "pending";
}

/**
 * Consecutive failed `/api/runs/:id/state` polls tolerated before a run is
 * declared unobservable. At the store's 2s poll interval this is ~10s of grace.
 */
export const MAX_RUN_POLL_FAILURES = 5;

/**
 * What the funnel remembers about ONE execution.
 *
 * Extracted from `startRunPolling` because the two bugs found in review round 1
 * both lived in this state machine — a latch seeded from the wrong flag, and a
 * failure counter that didn't exist — and neither was reachable by a test while
 * the logic was tangled with React refs, timers and `api.getRunState`. Reverting
 * either fix left the whole suite green. The rules are the part worth pinning,
 * so they live here as a pure function and the store becomes a thin driver.
 */
export interface RunFunnelState {
  /** `agent.run_started` has been emitted for this executionId. */
  started: boolean;
  /** A terminal event has been emitted. At most one, ever. */
  settled: boolean;
  /** At least one poll came back with a run state. */
  observed: boolean;
  /** Consecutive failed polls since the last success. */
  failures: number;
}

export function initialRunFunnelState(): RunFunnelState {
  return { started: false, settled: false, observed: false, failures: 0 };
}

/**
 * `announced` — the run was announced to the Studio. `duplicate` marks a
 * REDELIVERED announcement (same executionId seen before), which must not
 * re-count the start and must NOT pre-settle the outcome.
 */
export type RunFunnelEvent =
  | { kind: "announced"; duplicate: boolean }
  | { kind: "polled"; status: RunView["status"] }
  | { kind: "poll_failed" };

/** What the caller should send, if anything. */
export type RunFunnelEmit =
  | { event: null }
  | { event: "agent.run_started" }
  | { event: "agent.run_succeeded" }
  | { event: "agent.run_failed"; error_kind: RunErrorKind };

const EMIT_NOTHING: RunFunnelEmit = { event: null };

/**
 * The funnel's whole decision, as a pure step.
 *
 * Invariants this encodes, each of which was a bug at some point:
 *
 *  - A duplicate announcement suppresses only the START. The terminal event
 *    stays free to fire — collapsing these two into one latch means a
 *    redelivered `execution.started` yields a `run_started` and no terminal,
 *    ever, which is the opposite of the rule it was meant to protect.
 *  - At most one terminal event per run, because two overlapping in-flight
 *    polls can both observe the terminal status before either stops the timer.
 *  - A failed poll is not a failed run until `maxFailures` consecutive
 *    failures. `/api/runs/:id/state` answers 503 whenever the harness holds no
 *    credential while the coding agent runs with its own, and 502 on a gateway
 *    blip; both recover, and the run completes fine server-side.
 *  - A success RESETS the failure count, so a blip mid-run doesn't accumulate
 *    across an otherwise healthy run and trip the threshold later.
 *  - `unobservable` (never saw the run at all — almost always a server
 *    predating the endpoint) is distinct from `exception` (watched it, lost
 *    it). The distinction only means anything because we retried first.
 */
export function runFunnelStep(
  state: RunFunnelState,
  event: RunFunnelEvent,
  maxFailures: number = MAX_RUN_POLL_FAILURES,
): { state: RunFunnelState; emit: RunFunnelEmit } {
  if (event.kind === "announced") {
    if (event.duplicate || state.started) return { state, emit: EMIT_NOTHING };
    return { state: { ...state, started: true }, emit: { event: "agent.run_started" } };
  }

  if (event.kind === "polled") {
    const observed = { ...state, observed: true, failures: 0 };
    if (event.status === "running") return { state: observed, emit: EMIT_NOTHING };
    if (state.settled) return { state: observed, emit: EMIT_NOTHING };
    const settled = { ...observed, settled: true };
    return event.status === "completed"
      ? { state: settled, emit: { event: "agent.run_succeeded" } }
      : { state: settled, emit: { event: "agent.run_failed", error_kind: runErrorKind(event.status) } };
  }

  const failures = state.failures + 1;
  const counted = { ...state, failures };
  if (failures < maxFailures || state.settled) return { state: counted, emit: EMIT_NOTHING };
  return {
    state: { ...counted, settled: true },
    emit: {
      event: "agent.run_failed",
      error_kind: state.observed ? "exception" : "unobservable",
    },
  };
}

/** The provenance bucket carried as `source` on the lifecycle events. */
export type AgentSource = "template" | "starter" | "fork" | "scratch";

/**
 * The marker-derived provenance subset of WorkflowInfo. Deliberately excludes
 * `WorkflowInfo["source"]` ("scan"/"connect" — how the REGISTRY learned of the
 * path), which is a different dimension from the event `source` computed here.
 */
type ProvenanceFields = Pick<WorkflowInfo, "templateId" | "forkId" | "starterId">;

/** Only a non-empty string counts — the marker is user-editable JSON that the
 *  server casts wholesale, and events.ts promises ids stay strings. */
function asId(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Which provenance bucket a project falls in, from its sapiom.json fields.
 * Order matters: a gallery clone writes `templateId` AND `forkId`, so template
 * must win over fork; `starterId === "default"` is the bare/from-scratch
 * scaffold marker, not a named starter. No fields at all is `scratch` too —
 * that covers agents that predate provenance (and older harness servers).
 */
export function agentSource(workflow: ProvenanceFields): AgentSource {
  if (asId(workflow.templateId)) return "template";
  const starter = asId(workflow.starterId);
  if (starter && starter !== "default") return "starter";
  if (asId(workflow.forkId)) return "fork";
  return "scratch";
}

/**
 * The spreadable `source`/`template_id` payload fragment for the lifecycle
 * events. `template_id` is the public id of what the agent was made from —
 * gallery template id or bundled starter id; omitted for fork (a fork id is a
 * per-user record id, useless for breakdowns) and scratch. `{}` when the
 * registry entry wasn't found at all: an absent property reads "(not set)" in
 * PostHog and points at a wiring bug instead of silently inflating `scratch`.
 */
export function agentProvenance(
  workflow: ProvenanceFields | null | undefined,
): { source?: AgentSource; template_id?: string } {
  if (!workflow) return {};
  const source = agentSource(workflow);
  if (source === "template") return { source, template_id: asId(workflow.templateId) };
  if (source === "starter") return { source, template_id: asId(workflow.starterId) };
  return { source };
}
