/**
 * What the centre shows, as ONE pure function (design.md I2).
 *
 * The centre used to be decided by seven ordered booleans in `App.tsx`, and
 * their ORDER was the only thing that kept two of them from rendering at once:
 * a project selected over a session in another project rendered "No active
 * session in this project" beside the project's map while that session kept
 * running elsewhere. A discriminated union cannot render two things.
 *
 * The centre is one thing at a time (flow-navigation.md 4): a session's
 * workbench, or a project's Agent Map, never both side by side, which is the
 * half of the ask the requester called out as the important part.
 */

/**
 * What the user last pointed the centre at. One slot, so a project click and a
 * session click cannot both be "current". The selected SESSION is held apart
 * (ui-prefs `activeSessionId`): a project or agent click never writes it, so
 * the session stays highlighted in the rail and one click brings it back
 * (flow 4.3.2).
 */
export type CentreView =
  | { kind: "session" }
  | { kind: "project"; projectId: string }
  /** An agent's canvas, entered from its project's map (double click or Open
   *  canvas). Still the project view: no chat and no right pane. */
  | { kind: "agent"; projectId: string; path: string };

export type Centre =
  | { kind: "review" }
  | { kind: "composer" }
  | { kind: "project-map"; projectId: string }
  | { kind: "agent-canvas"; projectId: string; path: string }
  | { kind: "dead"; sessionId: string }
  | { kind: "workbench"; sessionId: string }
  | { kind: "no-session" }
  | { kind: "no-project" };

export interface CentreInput {
  view: CentreView;
  /** The selected session, if the server still lists it. */
  session: { id: string; status: string } | null;
  /** A past session from History is under review. */
  reviewing: boolean;
  /** The new-agent screen is open, scoped to a project. */
  composing: boolean;
  /** At least one project is open in the rail. */
  hasProjects: boolean;
}

/**
 * Precedence, and why:
 *
 *  1. review and the new-agent screen are explicit destinations the user just
 *     asked for, so they win over whatever the view held;
 *  2. a project or agent view is the map, whatever session is selected;
 *  3. a selected session is its workbench, or its dead pane once it exited
 *     (ending keeps it selected rather than jumping to another session, D43);
 *  4. nothing selected says so, and points at the rail.
 */
export function centrePane(input: CentreInput): Centre {
  if (input.reviewing) return { kind: "review" };
  if (input.composing) return { kind: "composer" };
  const { view, session } = input;
  if (view.kind === "project")
    return { kind: "project-map", projectId: view.projectId };
  if (view.kind === "agent")
    return {
      kind: "agent-canvas",
      projectId: view.projectId,
      path: view.path,
    };
  if (session)
    return session.status === "exited"
      ? { kind: "dead", sessionId: session.id }
      : { kind: "workbench", sessionId: session.id };
  return input.hasProjects ? { kind: "no-session" } : { kind: "no-project" };
}

/** The project the centre is about, when it is a project view. */
export function shownProjectId(centre: Centre): string | null {
  return centre.kind === "project-map" || centre.kind === "agent-canvas"
    ? centre.projectId
    : null;
}
