import type { JSX, ReactNode } from "react";

import type { ProjectMapEntry } from "../lib/use-project-map";
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

/** What the project view draws: the map pane, or the agents as cards. */
export type ProjectMapMode = { kind: "map" } | { kind: "cards" };

/**
 * Whether the project view shows the MAP PANE or the agent CARDS.
 *
 * Cards stand in for a map that cannot be drawn: a project with no durable
 * Studio project behind it (an older server, the mock's default fixtures), or
 * a working copy whose map came back with no agent while the agent list has
 * some. Without the cards those agents would be unreachable.
 *
 * The map pane keeps everything else, each state with its own recovery:
 * loading, a read error with Reload map, a project that is gone, and a git
 * ref with no agents (the header's ref selector must stay to leave it).
 */
export function projectMapMode(input: {
  entry: ProjectMapEntry;
  /** The server issued a durable Studio project for this scope. */
  durable: boolean;
}): ProjectMapMode {
  const { state, mapRef } = input.entry;
  if (state.status === "ready" && state.value.map.agents.length > 0) return { kind: "map" };
  if (!input.durable) return { kind: "cards" };
  if (state.status !== "ready" || mapRef !== null) return { kind: "map" };
  return { kind: "cards" };
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
