import type { WorkflowInfo } from "@shared/types";

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
