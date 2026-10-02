/**
 * Moving an agent means moving its directory on disk (SAP-2930). The map's
 * agent panel is the one place that asks for it now: Change location, behind
 * a confirm naming both paths (flow-navigation.md 4.4.3). The rail's
 * drag-to-move it replaced moved an agent on a gesture that could land by
 * accident.
 *
 * This module is the DECISION, not the I/O. The caller that actually performs
 * the move guards itself again: see `../../../src/server/agent-move.ts`. A
 * validator is not a permission system, and in the reference prototype the
 * mover rewrote paths unconditionally, so anything reaching it around the
 * client clobbered silently.
 */
import { basenameOf, isWithinDir, samePath, stripTrailingSep } from "./paths";

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
 * Why `from` must not move to `to`, in words the panel can show under its
 * field, or null when it may.
 *
 * Asked twice on purpose: by the map's agent panel before Move… is enabled,
 * and by the mock mover as its own last line. The real mover is
 * `../../../src/server/agent-move.ts`, which stats the disk; this checks only
 * what the registry can see, so a collision with a non-agent directory is the
 * endpoint's to refuse.
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
