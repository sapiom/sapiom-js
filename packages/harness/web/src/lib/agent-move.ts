/**
 * Moving an agent on the PROJECT axis means moving its directory on disk
 * (SAP-2930; design.md § Drag semantics, criteria 15–17).
 *
 * The Project axis is DERIVED from real paths, so a drag has exactly two
 * honest outcomes: move the directory, or refuse. The third option — record a
 * display override and leave the files where they are — would make the rail
 * assert a location that is not true, which is the one thing this axis exists
 * to be trustworthy about. Rearranging without touching disk is what the GROUP
 * axis is for (`agent-groups.ts`), and that axis makes no filesystem promise.
 *
 * This module is the DECISION, not the I/O. It validates a proposed move and
 * returns the exact from/to, so the same rules apply whichever caller asks —
 * and the caller that actually performs the move guards itself again. See
 * `../../../src/server/agent-move.ts`: a planner is not a permission system,
 * and in the reference prototype the mover rewrote paths unconditionally, so
 * anything reaching it around the rail clobbered silently.
 */
import { basenameOf, isWithinDir, joinPath, parentOf, samePath, stripTrailingSep } from "./paths";

/**
 * The drag payload's MIME type, and the marker that this drag OFFERS A DISK
 * MOVE. The Group axis's own drag (`GroupRow.tsx`) carries different types, so
 * a group drag can never light up a directory row or reach the mover — the two
 * axes cannot be confused into moving files, structurally rather than by an
 * `if` somewhere.
 *
 * The payload rides in `dataTransfer`, NOT in component state: `dragstart` and
 * `drop` can land in the same tick, and a state setter has not re-rendered by
 * then, so a state-held payload reads as `null` exactly when the drop needs it.
 * `getData` is deliberately blank during `dragover` (the spec's protected
 * mode), so a hover highlight keys on `types` and only the drop reads values.
 */
export const DRAG_MOVE_TYPE = "application/x-sapiom-agent-move";

/** A refused move says why, in words a row can show. An EMPTY reason is the
 *  silent refusal — see `planMove`. */
export type MovePlan =
  | { ok: true; from: string; to: string; name: string }
  | { ok: false; reason: string };

/**
 * The path `p` becomes once `from` has moved to `to` — unchanged when `p` is
 * not inside `from`.
 *
 * Everything UNDER the moved directory travels with it: an agent nested inside
 * the one being dragged is carried along, because on disk it has no choice.
 * Forgetting this is how a nested agent ends up pointing at a path that no
 * longer exists while its parent renders happily at the new one. The same rule
 * applies to a SESSION whose cwd sat inside the moved tree.
 *
 * The suffix is measured on the original string, so the result keeps the
 * caller's own separator spelling; `isWithinDir` already proved containment on
 * the normalized pair, and a separator is one character either way, so the
 * length is the same whichever way each side was spelled.
 */
export function remapUnder(p: string, from: string, to: string): string {
  if (!isWithinDir(from, p)) return p;
  if (samePath(p, from)) return to;
  return to + p.slice(stripTrailingSep(from).length);
}

/**
 * Applies a completed move to a list of paths — agent paths, session cwds, or
 * anything else keyed by location. See `remapUnder` for why the whole subtree
 * travels.
 */
export function applyMove(paths: readonly string[], from: string, to: string): string[] {
  return paths.map((p) => remapUnder(p, from, to));
}

/**
 * THE SECOND GUARD, in the terms the mover speaks (`from`/`to` rather than a
 * drag's target directory) — a message when the move must not happen, null when
 * it may.
 *
 * `planMove` is the DECISION: it runs on the drag, in the rail, and produces the
 * reason a row shows. This is not a second opinion, it is the last line — the
 * mover rewrites paths, and until it existed the only thing between a bad `to`
 * and a silently clobbered agent was the caller having asked `planMove` first.
 * The real mover is `../../../src/server/agent-move.ts`, which stats the disk;
 * this is the same shape of guard for the mock server, which has no disk to
 * stat and can only check what the registry can see.
 *
 * A `to` that equals `from` is not a refusal: nothing moves, nothing is at risk.
 */
export function refuseMove(
  knownPaths: readonly string[],
  from: string,
  to: string,
): string | null {
  if (samePath(from, to)) return null;
  if (isWithinDir(from, to)) return `Can't move ${basenameOf(from)} inside itself.`;
  // Everything under `from` travels WITH the move, so none of those paths is
  // the thing already sitting at the destination.
  const traveling = (p: string): boolean => isWithinDir(from, p);
  if (knownPaths.some((p) => !traveling(p) && isWithinDir(to, p))) {
    return `${to} already exists. Moving ${basenameOf(to)} there would overwrite it.`;
  }
  return null;
}

/**
 * Validates dragging the agent at `agentPath` into the directory `targetDir`.
 *
 * `knownPaths` is every agent path the rail holds — used only to refuse a move
 * that would land on top of one. It is NOT a filesystem listing, so a collision
 * with a non-agent directory of the same name is not caught here; that check
 * needs a real `stat` and belongs to the endpoint that performs the move.
 * Refusing what we can see beats clobbering silently, and the endpoint refuses
 * the rest independently.
 *
 * Three refusals carry a reason the row can show, and one refusal is SILENT: a
 * drop into the folder the agent already occupies. The user let go somewhere
 * harmless and deserves silence, not a complaint.
 */
export function planMove(
  agentPath: string,
  targetDir: string,
  knownPaths: readonly string[],
): MovePlan {
  const name = basenameOf(agentPath);
  const to = joinPath(targetDir, name);

  // Dropped on its own row-as-directory. `to` would be `<agent>/<agent>`, which
  // the subtree check below would also catch, but the honest reason is that the
  // gesture asked for the one destination an agent can never have.
  if (samePath(agentPath, targetDir)) {
    return { ok: false, reason: `Can't move ${name} into itself.` };
  }
  // THE SILENT ONE. Nothing moves, nothing is at risk, and there is nothing to
  // say — an error toast here would punish a harmless gesture.
  const parent = parentOf(agentPath);
  if (parent != null && samePath(parent, targetDir)) {
    return { ok: false, reason: "" };
  }
  // `mv a a/b` relocates the destination along with the source and leaves
  // nothing behind — the one move that destroys the thing being moved.
  if (isWithinDir(agentPath, targetDir)) {
    return { ok: false, reason: `Can't move ${name} inside itself.` };
  }
  // Everything under `agentPath` TRAVELS with the move, so those paths cannot
  // be the thing already sitting at the destination. Without this exclusion a
  // move of any directory with children would refuse itself.
  const traveling = (p: string): boolean => isWithinDir(agentPath, p);
  if (knownPaths.some((p) => !traveling(p) && isWithinDir(to, p))) {
    return {
      ok: false,
      reason: `${basenameOf(targetDir)} already has an agent called ${name}.`,
    };
  }
  return { ok: true, from: agentPath, to, name };
}
