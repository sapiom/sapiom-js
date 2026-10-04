import { describe, expect, it } from "vitest";

import {
  centrePane,
  shownProjectId,
  type Centre,
  type CentreInput,
  type CentreView,
} from "./centre-pane";

/**
 * design.md I2: every View × session state lands on exactly one kind. The
 * table is exhaustive over the inputs that change the answer, so a new branch
 * that lets two states render at once has nowhere to hide.
 */

const VIEWS: Record<string, CentreView> = {
  session: { kind: "session" },
  project: { kind: "project", projectId: "p1" },
};
const SESSIONS: Record<string, CentreInput["session"]> = {
  none: null,
  live: { id: "s1", status: "running" },
  starting: { id: "s1", status: "starting" },
  exited: { id: "s1", status: "exited" },
};

const base = (overrides: Partial<CentreInput> = {}): CentreInput => ({
  view: VIEWS.session!,
  session: null,
  reviewing: false,
  composing: false,
  hasProjects: true,
  ...overrides,
});

describe("centrePane: one View × session state, one kind", () => {
  const expected: Record<string, Record<string, Centre["kind"]>> = {
    session: { none: "no-session", live: "workbench", starting: "workbench", exited: "dead" },
    project: { none: "project-map", live: "project-map", starting: "project-map", exited: "project-map" },
  };
  for (const [viewName, view] of Object.entries(VIEWS)) {
    for (const [sessionName, session] of Object.entries(SESSIONS)) {
      const want = expected[viewName]![sessionName]!;
      it(`${viewName} view, ${sessionName} session → ${want}`, () => {
        expect(centrePane(base({ view, session })).kind).toBe(want);
      });
    }
  }

  it("a project view never shows the selected session's chat", () => {
    const centre = centrePane(base({ view: VIEWS.project!, session: SESSIONS.live! }));
    expect(centre).toEqual({ kind: "project-map", projectId: "p1" });
  });

  it("review and the new-agent screen win over every view", () => {
    for (const view of Object.values(VIEWS)) {
      expect(centrePane(base({ view, session: SESSIONS.live!, reviewing: true })).kind).toBe("review");
      expect(centrePane(base({ view, session: SESSIONS.live!, composing: true })).kind).toBe("composer");
    }
  });

  it("says no project when nothing is open, and no session when projects are", () => {
    expect(centrePane(base({ hasProjects: false })).kind).toBe("no-project");
    expect(centrePane(base({ hasProjects: true })).kind).toBe("no-session");
  });
});

describe("shownProjectId", () => {
  it("names the project only for the map", () => {
    expect(shownProjectId({ kind: "project-map", projectId: "p1" })).toBe("p1");
    expect(shownProjectId({ kind: "workbench", sessionId: "s1" })).toBeNull();
  });
});
