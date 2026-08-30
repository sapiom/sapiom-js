/**
 * The canvas has ONE subject and TWO altitudes.
 *
 * The project map and the agent board are not different kinds of thing, so the
 * map is not a fourth tab: they are the same canvas looked at from two heights.
 *
 *   map   — a project: its agents and the edges between them
 *   board — an agent: that agent's steps
 *
 * Moving between them is a CUT, not a zoom — the stance ratified in
 * `plans/studio-redesign/ROADS-NOT-TAKEN.md` ("fixed named altitudes you cut
 * between"), chosen because cutting preserves spatial memory and zooming
 * destroys it. The graph's own pan/zoom/fit is untouched; it operates WITHIN
 * an altitude, which was never in dispute.
 *
 * Pure and free of React on purpose, for the same reason `session-scope.ts` is:
 * the rail and the canvas must always agree about which altitude is showing,
 * and a rule you can call with two arguments is a rule a test can pin. Two
 * surfaces that can disagree about what you are looking at is the bug this
 * module exists to make impossible.
 */
import type { WorkspaceKey, WorkspaceScopeSummary } from "@shared/system-graph";

import { basenameOf, samePath } from "./paths";
import { projectRootForAgent } from "./session-scope";

/** A project as both surfaces need it: the rail's row and the graph's key. */
export interface ProjectRef {
  /** The opaque key the SERVER issued for this project's graph. The browser
   *  never invents one from a path — it joins an exact root to a scope. */
  workspaceKey: WorkspaceKey;
  /** The project root on disk (the Project-axis row's root). */
  root: string;
  /** What the rail calls it. */
  label: string;
}

export type CanvasAltitude = "map" | "board";

export type CanvasView =
  | { altitude: "map"; project: ProjectRef }
  | { altitude: "board"; agentPath: string | null };

/**
 * The one answer to "what is the canvas showing", from the one selection.
 *
 * A selected project wins. The two are mutually exclusive by construction —
 * every door that selects an agent clears the project and vice versa — and
 * this function is where that is STATED, so a door that forgets one half
 * still resolves to a single honest altitude instead of drawing an agent's
 * board under a project's name.
 */
export function canvasView(
  project: ProjectRef | null,
  agentPath: string | null,
): CanvasView {
  if (project) return { altitude: "map", project };
  return { altitude: "board", agentPath };
}

/**
 * Join a project root to the graph key the server issued for it.
 *
 * Segment-aware equality, matching the rail's own join: the server hands us
 * resolved native paths (Windows included) while a root can arrive with a
 * trailing separator, and a bare string compare would silently fail to find
 * the key and present the project as un-mappable.
 */
export function projectRefForRoot(
  root: string | null,
  label: string | null,
  scopes: readonly WorkspaceScopeSummary[],
): ProjectRef | null {
  if (!root) return null;
  const scope = scopes.find((candidate) => samePath(candidate.cwd, root));
  if (!scope) return null;
  return { workspaceKey: scope.workspaceKey, root, label: label ?? basenameOf(root) };
}

/**
 * The project an agent's board can cut UP to, or null.
 *
 * DERIVED from containment on every call, never remembered from the click that
 * drilled down. Remembering it would make the way back depend on how you got
 * here — an agent reached from the rail would have no way up while the same
 * agent reached from the map would — and it would go stale the moment a
 * project is removed or an agent is moved. Derived, the way up is the same
 * one door however you arrived, and it disappears exactly when the project does.
 */
export function projectAbove(
  agentPath: string | null,
  roots: readonly string[],
  scopes: readonly WorkspaceScopeSummary[],
): ProjectRef | null {
  if (!agentPath) return null;
  const root = projectRootForAgent(agentPath, roots);
  // `projectRootForAgent` falls back to the agent's own folder when no known
  // root contains it. That is not a project, and offering "up" to it would
  // send the user to a map of one agent — itself.
  if (samePath(root, agentPath)) return null;
  return projectRefForRoot(root, null, scopes);
}

/**
 * Why `Steps` cannot answer at map altitude, or null when it can.
 *
 * Steps are an AGENT's steps. A project has no step list, and a tab that
 * silently keeps showing the last agent's steps under a project's name is the
 * failure — so the tab is disabled and says which subject it needs. Returned
 * as the sentence itself, not a boolean, because a disabled control without
 * its reason is mute (the same rule `lifecycleVerbGate` follows).
 */
export function stepsDisabledReason(altitude: CanvasAltitude): string | null {
  return altitude === "map"
    ? "Steps belong to one agent — select an agent to see them"
    : null;
}
