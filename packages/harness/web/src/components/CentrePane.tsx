import type { JSX, ReactNode } from "react";

import type { AgentMapWorkspacePaneState } from "../lib/use-agent-map-entry";
import { EmptyState } from "./EmptyState";

/**
 * The project view's frame (flow-navigation.md 4.3, D45, D49): the project's
 * Agent Map at the FULL centre width, or the canvas of an agent entered from
 * it. No chat and no right pane beside it, ever: the map squeezed into a pane
 * beside a conversation is what the requester asked to stop ("it would take up
 * the full view in the middle rather than having to share real estate with the
 * chat"). `data-view` says which of the two it holds.
 */
export function ProjectView({
  showing,
  children,
}: {
  showing: "map" | "agent";
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="project-map-pane"
      data-testid="project-map-pane"
      data-view={showing}
    >
      {children}
    </div>
  );
}

/** What the project view draws: the map pane, or the agents as cards with a
 *  word on where the map is. */
export type ProjectMapMode =
  | { kind: "map" }
  | { kind: "cards"; map: "not-drawn" | "generating" | "failed" };

/**
 * Whether the project view shows the MAP PANE or the agent CARDS.
 *
 * Cards stand in for any map that is not drawn: a project with no durable
 * Studio project behind it (an older server, the mock's default fixtures), a
 * map still being generated, one whose generation failed, or one that came
 * back with nothing in it. The agent panel then works on every project, not
 * only on the ones whose map exists (design.md §3, mock `ProjectAgentGrid`);
 * without the cards, a failed generation would leave a project's agents
 * unreachable. The cards carry the generation state and its Retry.
 *
 * The map pane keeps the states that are about the map's STORAGE, each with
 * its own recovery: loading, a read error with Reload map, and a durable
 * project that is gone or foreign.
 */
export function projectMapMode(input: {
  state: AgentMapWorkspacePaneState;
  unavailable: string | null;
  /** The server issued a durable Studio project for this scope. */
  durable: boolean;
  initialization: { status: string } | null | undefined;
}): ProjectMapMode {
  // A drawn map is the map, whatever the catalog says about the project.
  if (
    input.state.status === "ready" &&
    (input.state.value.proposal?.nodes.length ?? 0) > 0
  )
    return { kind: "map" };
  if (!input.durable) return { kind: "cards", map: "not-drawn" };
  if (input.unavailable || input.state.status !== "ready") return { kind: "map" };
  const generation = input.initialization?.status;
  if (generation === "queued" || generation === "running")
    return { kind: "cards", map: "generating" };
  if (generation === "failed") return { kind: "cards", map: "failed" };
  return { kind: "cards", map: "not-drawn" };
}

/**
 * Nothing selected, with projects in the rail: say so and point at the rail.
 * The project view never shows a session, so this is the one absence the
 * centre has (flow 4.6).
 */
export function NoSessionSelected(): JSX.Element {
  return (
    <EmptyState
      className="terminal-empty"
      testId="no-session-selected"
      icon="Radio"
      title="No session selected"
      body="Pick a session in the rail, or press + on a project to start one. Click a project to see its agents."
    />
  );
}
