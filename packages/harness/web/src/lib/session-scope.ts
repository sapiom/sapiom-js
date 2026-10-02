/**
 * Session scope: where a new session is ROOTED.
 *
 * One rule lives here, and it was a bug before it was a rule: a session boots
 * at its PROJECT ROOT, never at the agent's own folder. Rooting in an agent
 * subdirectory is why Claude Code came up without the project's `CLAUDE.md`,
 * `.claude/` or skills — the whole benefit of an embedded agent, lost to a
 * path (SAP-2927; design.md § Sessions, focus, canvas, verbs, criterion 18).
 *
 * Pure and free of React and of fixtures on purpose: a test pins the rule with
 * two string arguments, so the rule cannot quietly start depending on shell
 * state, the mock data, or the API client. Every session-creation entry point
 * in `App.tsx` resolves through `projectRootForAgent` — the original defect
 * was one path that didn't.
 */
import { isWithinDir, samePath, stripTrailingSep } from "./paths";
import {
  prodRunDisabledReason,
  type DeployableWorkflow,
} from "./workflow-deployment";

/**
 * True when `root` contains `agentPath`, matched on SEGMENT boundaries.
 *
 * There is exactly ONE containment answer in this app and it is
 * `paths.isWithinDir`, which already normalizes separators (the server hands
 * us native paths, Windows included) and already refuses a bare string prefix
 * — without that, `~/polsia-old` reads as a child of `~/polsia` and the studio
 * boots a session in a project the agent has nothing to do with. This wrapper
 * exists for the one thing the generic helper cannot decide: an EMPTY root is
 * not a root. It prefixes every path, so left alone it would swallow every
 * agent and win the longest-root sort's tie for last place.
 *
 * Equality counts as containment: a project root that IS the agent is one row
 * and one context.
 */
export function rootContains(root: string, agentPath: string): boolean {
  if (root.trim() === "") return false;
  return isWithinDir(root, agentPath);
}

/**
 * The project root that owns an agent: the LONGEST known root containing it.
 *
 * Longest, not first: `recentDirs` is ordered by recency, which says nothing
 * about depth. With both `~/polsia` and `~/polsia/backend/src/agents/ads`
 * opened, the nearer one is the context the user chose for this agent, and the
 * answer must not depend on which they opened last.
 *
 * With no known root containing it we fall back to the agent's own folder —
 * the old behaviour, returned verbatim — so an agent discovered outside every
 * opened project still starts a session rather than failing to start.
 */
export function projectRootForAgent(
  agentPath: string,
  roots: readonly string[],
): string {
  return (
    roots
      .filter((root) => rootContains(root, agentPath))
      // A root recorded as `~/polsia/` is the same place as `~/polsia`, and the
      // trailing slash must not buy it a character in the sort below.
      .map(stripTrailingSep)
      .sort((a, b) => b.length - a.length)[0] ?? agentPath
  );
}

// ---------------------------------------------------------------------------
// Selection, not binding: what each surface is ABOUT (SAP-2931)
//
// The rules below are the second half of this module's job. SAP-2927 answered
// "where does a session boot"; these answer "what is on screen, and what do
// the buttons act on" — and the answer stopped being the session's binding.
//
// Every one of them was a bug before it was a rule, and three of them were
// reported met while broken in the reference prototype, which is why they are
// pure functions with names: a rule you can call is a rule you can pin.
// ---------------------------------------------------------------------------

/** The workflow fields the subject rules read (`WorkflowInfo` satisfies it). */
export interface SubjectWorkflow {
  path: string;
  name: string;
}

/** A run and the workflow it was attributed to when it was announced. */
export interface AttributedRun {
  /** The workflow bound to the run's session at announcement time, or null
   *  when nothing was bound. Captured once, never re-derived. */
  workflowPath: string | null;
  run: { executionId: string };
}

/** Where the pane's canvas document comes from. */
export type CanvasSource =
  /** Nothing to draw. */
  | { kind: "none" }
  /** `/canvas/:sessionId/` — the session-keyed board, resolved server-side by
   *  that session's current binding. */
  | { kind: "session"; sessionId: string }
  /** `GET /api/workflows/:path/graph` — the session-free entry point onto the
   *  same derivation (IA-01). Keyed by the AGENT's directory path; the route's
   *  own segment keeps the legacy word because it is a shipped API surface. */
  | { kind: "agent"; path: string };

export interface CanvasSourceInput {
  /** The agent the pane is drawing. */
  subjectPath: string | null;
  /** What the active session is bound to, or null. */
  bindingPath: string | null;
  /** The active session, or null. */
  sessionId: string | null;
}

/**
 * Which of the two canvas entry points serves the subject's board.
 *
 * The session-keyed route wins whenever the active session is bound to the
 * subject, and it is not a mere preference: that route is the one the live
 * `canvas.reload` bus messages address, the one the run-state bridge posts
 * into, and the one whose document a fresh render replaces in place. Reaching
 * for the workflow-keyed route there would trade a live board for a snapshot.
 *
 * Everywhere else — a sibling selected while the session talks to another
 * agent, an agent that has never hosted a session at all — the workflow-keyed
 * route is the only one that can answer, because `/canvas/:sessionId/` resolves
 * by the session's binding and would serve the wrong agent's board.
 */
export function canvasSourceFor({
  subjectPath,
  bindingPath,
  sessionId,
}: CanvasSourceInput): CanvasSource {
  // Both absent counts as agreement, and it matters: a live session bound to
  // nothing (a bare-folder scaffold session) has always drawn its OWN board
  // here, and the pane's empty-state copy speaks about that session. Treating
  // "no subject" as "no source" turned that into a fresh-install "No session"
  // message under a session that was plainly running.
  const agrees =
    subjectPath == null
      ? bindingPath == null
      : bindingPath != null && samePath(bindingPath, subjectPath);
  // Ended sessions can still serve their saved Canvas; liveness does not choose the source.
  if (sessionId != null && agrees) return { kind: "session", sessionId };
  if (subjectPath == null) return { kind: "none" };
  return { kind: "agent", path: subjectPath };
}

// ---------------------------------------------------------------------------
// Lifecycle verbs: GATED by the selection, not merely aimed at it
// ---------------------------------------------------------------------------

/**
 * The four verbs the agent action cluster carries, named as the design names
 * them and mapped to what the bar actually renders:
 *
 *   `prod`   — the globe: open THIS agent in the Sapiom dashboard
 *   `test`   — Run · Local (agent code here, Sapiom calls stubbed)
 *   `run`    — Run · Cloud (the deployed build, real capabilities)
 *   `deploy` — push + cloud build
 */
export type LifecycleVerb = "prod" | "test" | "run" | "deploy";

/** The subject fields a verb gate reads: identity plus deployment evidence. */
export interface GatedWorkflow extends SubjectWorkflow, DeployableWorkflow {}

export interface VerbGateInput<W extends GatedWorkflow> {
  /** The agent the pane is about — the ONLY thing a verb may act on. */
  subject: W | null;
  /** Whether the user is signed in (gates the two cloud verbs). */
  authenticated: boolean;
  /** The SUBJECT's last failed deploy message, or null. Must be looked up by
   *  the subject's path, not the binding's: a stale error from the agent the
   *  session happens to be bound to would disable a verb on a healthy one. */
  deployError: string | null;
}

export interface VerbGate {
  /** The agent the verb acts on — the selection, or null when there is none.
   *  Returned alongside the reason on purpose: the prototype's bug was that
   *  these two came from DIFFERENT agents, and a gate that hands back both
   *  cannot be half-wired. */
  subjectPath: string | null;
  /** Why the verb cannot act, or null when it can. Rendered into BOTH
   *  `aria-label` and `data-tooltip` — a disabled control without its reason
   *  is mute. */
  reason: string | null;
}

/**
 * Whether a lifecycle verb can act on the current selection, and on what.
 *
 * This exists because wiring the verbs' action TARGET to the selection is not
 * enough and looks done. In the reference prototype the handlers were rewired
 * and the buttons stayed enabled off the BOUND agent's deployment state:
 * selecting the undeployed `rfq` left Prod and Run live against `leasing`. That
 * is the exact mis-target this function prevents — talking about B, looking at
 * F, deploying B. Subject and enabled-state come out of one call, from one
 * input, so they cannot drift apart again.
 *
 * `test` is deliberately NOT gated on deployment: running local is precisely
 * what you can do to an agent that has never been deployed, and `deploy` is
 * gated only on auth for the same reason. Disabling the two verbs that would
 * fix the state you are being told about would be honest about nothing.
 */
export function lifecycleVerbGate<W extends GatedWorkflow>(
  verb: LifecycleVerb,
  { subject, authenticated, deployError }: VerbGateInput<W>,
): VerbGate {
  if (!subject) return { subjectPath: null, reason: "Select an agent first" };
  const subjectPath = subject.path;
  switch (verb) {
    case "prod":
      // No definition id means no agent page to open. The globe used to fall
      // back to the dashboard root, which read as "this agent is over there"
      // for an agent that has never been anywhere.
      return {
        subjectPath,
        reason: subject.definitionId == null ? "Not deployed yet" : null,
      };
    case "run":
      return {
        subjectPath,
        reason:
          (!authenticated ? "Connect your account first" : null) ??
          prodRunDisabledReason(subject, deployError),
      };
    case "deploy":
      return {
        subjectPath,
        reason: !authenticated ? "Connect your account first" : null,
      };
    case "test":
      return { subjectPath, reason: null };
  }
}

// ---------------------------------------------------------------------------
// Run evidence follows the SAME subject as the board
// ---------------------------------------------------------------------------

/**
 * The runs the pane may show: only those belonging to its subject.
 *
 * Runs are observed per SESSION but attributed to the workflow bound when they
 * were announced, and the selection and the session can now differ, so an
 * unfiltered list draws B's run over F's structure — a false account of what
 * ran, in the one surface whose whole job is telling you what ran.
 *
 * Attribution is EXACT, including the null case: a run announced with nothing
 * bound belongs to no agent and is shown only on a pane that is likewise about
 * no agent. That is this repo's existing rule (`observedRunMatchesWorkflow`),
 * and it is the stricter of the two available answers — the reference prototype
 * kept unattributed runs on every subject, which is how an unrelated run can
 * appear under an agent that never produced it.
 */
export function runsForSubject<R extends AttributedRun>(
  runs: readonly R[],
  subjectPath: string | null,
): R[] {
  return runs.filter((observed) => observed.workflowPath === subjectPath);
}

/**
 * How many runs the SPA holds for one subject.
 *
 * A retention policy, not a display cap. It exists because run evidence now
 * has more than one source: the active session's own announcements, plus the
 * runs OTHER sessions announced for this same agent — which the visible pane
 * could not see at all once selection and session diverged. Folding a second
 * source in without a bound is how the prototype's run picker came to offer
 * 309 runs in a client that retains 200 and can reopen none of the rest.
 *
 * `use-harness-state.ts` does not trim its own `runIdsBySession` today, so this
 * is the single enforcement point, applied at the merge that feeds the picker.
 * If a trim is ever added there it must import this constant rather than hold
 * a private copy: this is the module that owns run-evidence decisions.
 */
export const OBSERVED_RUN_WINDOW = 200;

/**
 * All the run evidence for one subject: what the active session announced,
 * plus what another session announced for the same agent and this one never
 * heard of.
 *
 * Announcements are addressed to the session BOUND to a workflow, so with the
 * selection decoupled the agent on screen usually has runs the active session
 * never announced. Those runs are still true, and the Steps tab exists to show
 * them; leaving them out is how a failed run stayed invisible in the one
 * surface whose job is to say what ran.
 *
 * The result is BOUNDED by the retention window, so "no longer retained" means
 * one thing whatever a run's source. Observed runs are never displaced to make
 * room: they are the active session's own, some still polling, and evicting
 * them for another session's finished history would drop the live half of the
 * evidence. The extras then fill what room is left, newest first by the same
 * oldest-first convention the lists use (tail = newest). The observed copy wins
 * a collision — it is the live one.
 */
export function mergeSubjectRuns<R extends AttributedRun>(
  observed: readonly R[],
  extra: readonly R[],
  limit: number = OBSERVED_RUN_WINDOW,
): R[] {
  if (limit <= 0) return [];
  const kept = observed.slice(-limit);
  const room = limit - kept.length;
  if (room <= 0) return kept;
  const seen = new Set(kept.map((entry) => entry.run.executionId));
  return [
    ...kept,
    ...extra.filter((entry) => !seen.has(entry.run.executionId)).slice(-room),
  ];
}

/**
 * The session's currently shown run, but only if it is the subject's run.
 *
 * Membership is by execution id, so a run the picker chose is kept while a run
 * belonging to another agent is dropped rather than re-attributed. This is what
 * stops the previous agent's run from lingering on the new subject's board.
 */
export function selectedRunForSubject<R extends AttributedRun>(
  runs: readonly R[],
  selected: R | null,
  subjectPath: string | null,
): R | null {
  if (!selected) return null;
  return runsForSubject(runs, subjectPath).some(
    (observed) => observed.run.executionId === selected.run.executionId,
  )
    ? selected
    : null;
}

/**
 * Which of the subject's runs the pane shows.
 *
 * The active session's own pick wins while it is still one of this subject's
 * runs, so a stale pick heals itself the moment the selection changes rather
 * than pinning one agent's run onto another's board. Then the newest known, so
 * a subject with evidence never renders as though nothing had ever run — which
 * is the whole reason another session's runs are merged in at all.
 */
export function shownRunForSubject<R extends AttributedRun>(
  runs: readonly R[],
  sessionRun: R | null,
): R | null {
  if (
    sessionRun &&
    runs.some((entry) => entry.run.executionId === sessionRun.run.executionId)
  ) {
    return sessionRun;
  }
  return runs.length > 0 ? runs[runs.length - 1] : null;
}
