import { describe, expect, it } from "vitest";

import {
  EXITED_LISTING_DAYS,
  IDLE_AFTER_MINUTES,
  isListed,
  railSessions,
  sessionForShortcut,
  sessionMark,
  sessionsForAgent,
  type ListedSession,
} from "./rail-sessions";

/**
 * design.md I1: ONE function answers "which sessions does project P list".
 * The truth table below is every input that changes the answer: live, idle,
 * exited inside and beyond the 7-day window, hidden, a foreign project, and a
 * session with no project identity at all.
 */

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const minutesAgo = (n: number): string =>
  new Date(NOW - n * 60_000).toISOString();
const daysAgo = (n: number): string =>
  new Date(NOW - n * 24 * 60 * 60_000).toISOString();

const A = "project_a";
const B = "project_b";
const NONE: ReadonlySet<string> = new Set();

const session = (
  id: string,
  overrides: Partial<ListedSession> = {},
): ListedSession => ({
  id,
  status: "running",
  createdAt: minutesAgo(60),
  lastActiveAt: minutesAgo(1),
  boundWorkflowPath: null,
  agentMapIdentity: { projectId: A },
  ...overrides,
});

describe("isListed: live always, exited for 7 days, hidden never", () => {
  it("lists a live session however old its activity is", () => {
    expect(isListed(session("s", { lastActiveAt: daysAgo(30) }), NONE, NOW)).toBe(true);
  });

  it("lists an exited session active inside the window", () => {
    const exited = session("s", { status: "exited", lastActiveAt: daysAgo(EXITED_LISTING_DAYS - 1) });
    expect(isListed(exited, NONE, NOW)).toBe(true);
  });

  it("drops an exited session active beyond the window (History keeps it)", () => {
    const exited = session("s", { status: "exited", lastActiveAt: daysAgo(EXITED_LISTING_DAYS + 1) });
    expect(isListed(exited, NONE, NOW)).toBe(false);
  });

  it("measures the window on lastActiveAt, falling back to createdAt", () => {
    const noActivity = session("s", {
      status: "exited",
      lastActiveAt: null,
      createdAt: daysAgo(EXITED_LISTING_DAYS + 1),
    });
    expect(isListed(noActivity, NONE, NOW)).toBe(false);
    expect(isListed({ ...noActivity, createdAt: daysAgo(1) }, NONE, NOW)).toBe(true);
  });

  it("hides an exited session the user closed with ×", () => {
    const exited = session("s", { status: "exited", lastActiveAt: minutesAgo(5) });
    expect(isListed(exited, new Set(["s"]), NOW)).toBe(false);
  });

  it("never hides a live session: a running process keeps its row", () => {
    expect(isListed(session("s"), new Set(["s"]), NOW)).toBe(true);
  });
});

describe("railSessions: one project's rows, newest activity first", () => {
  const rows = [
    session("old-live", { lastActiveAt: minutesAgo(30) }),
    session("new-live", { lastActiveAt: minutesAgo(1) }),
    session("recent-exit", { status: "exited", lastActiveAt: minutesAgo(10) }),
    session("stale-exit", { status: "exited", lastActiveAt: daysAgo(9) }),
    session("hidden-exit", { status: "exited", lastActiveAt: minutesAgo(2) }),
    session("foreign", { agentMapIdentity: { projectId: B } }),
    session("unowned", { agentMapIdentity: null }),
  ];

  it("lists the project's live and recent exited sessions in activity order", () => {
    expect(
      railSessions(rows, A, new Set(["hidden-exit"]), NOW).map((s) => s.id),
    ).toEqual(["new-live", "recent-exit", "old-live"]);
  });

  it("matches on project identity, never on a foreign project's rows", () => {
    expect(railSessions(rows, B, NONE, NOW).map((s) => s.id)).toEqual(["foreign"]);
  });

  it("gives a session with no project identity to no project", () => {
    expect(railSessions(rows, null, NONE, NOW)).toEqual([]);
    for (const projectId of [A, B]) {
      expect(railSessions(rows, projectId, NONE, NOW).map((s) => s.id)).not.toContain("unowned");
    }
  });

  it("breaks an activity tie by creation then id, so rows never swap", () => {
    const tied = [
      session("b", { lastActiveAt: minutesAgo(1), createdAt: minutesAgo(9) }),
      session("a", { lastActiveAt: minutesAgo(1), createdAt: minutesAgo(9) }),
      session("c", { lastActiveAt: minutesAgo(1), createdAt: minutesAgo(2) }),
    ];
    expect(railSessions(tied, A, NONE, NOW).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("draws a duplicated session once", () => {
    const one = session("dup");
    expect(railSessions([one, { ...one }], A, NONE, NOW)).toHaveLength(1);
  });
});

describe("sessionMark", () => {
  it("is exited for an exited session, whatever the bus says", () => {
    expect(sessionMark(session("s", { status: "exited" }), true, NOW)).toBe("exited");
  });

  it("is live while busy or starting, and idle after a quiet spell", () => {
    const quiet = session("s", { lastActiveAt: minutesAgo(IDLE_AFTER_MINUTES + 1) });
    expect(sessionMark(quiet, false, NOW)).toBe("idle");
    expect(sessionMark(quiet, true, NOW)).toBe("live");
    expect(sessionMark({ ...quiet, status: "starting" }, false, NOW)).toBe("live");
    expect(sessionMark(session("s", { lastActiveAt: minutesAgo(2) }), false, NOW)).toBe("live");
  });
});

describe("sessionsForAgent: the agent panel's list is the rail's, narrowed", () => {
  it("lists only sessions bound to the agent, in rail order", () => {
    const rows = [
      session("other", { boundWorkflowPath: "/p/other" }),
      // An unbound chat at the root is the project's, not this agent's.
      session("unbound", { boundWorkflowPath: null, lastActiveAt: minutesAgo(0) }),
      session("mine-old", { boundWorkflowPath: "/p/mine", lastActiveAt: minutesAgo(9) }),
      session("mine-new", { boundWorkflowPath: "/p/mine", lastActiveAt: minutesAgo(1) }),
      session("mine-stale", { boundWorkflowPath: "/p/mine", status: "exited", lastActiveAt: daysAgo(30) }),
    ];
    expect(sessionsForAgent(rows, A, "/p/mine", NONE, NOW).map((s) => s.id)).toEqual([
      "mine-new",
      "mine-old",
    ]);
  });
});

describe("sessionForShortcut: Cmd/Ctrl+N is the Nth row of the selected project", () => {
  const rows = [
    session("a1", { lastActiveAt: minutesAgo(1) }),
    session("a2", { lastActiveAt: minutesAgo(5), status: "exited" }),
    session("b1", { agentMapIdentity: { projectId: B } }),
  ];

  it("indexes the active session's project, exited rows included", () => {
    const input = { sessions: rows, hidden: NONE, now: NOW, shownProjectId: null, activeSessionId: "a1" };
    expect(sessionForShortcut(1, input)?.id).toBe("a1");
    expect(sessionForShortcut(2, input)?.id).toBe("a2");
    expect(sessionForShortcut(3, input)).toBeNull();
  });

  it("prefers the project whose map is showing over the active session's", () => {
    const input = { sessions: rows, hidden: NONE, now: NOW, shownProjectId: B, activeSessionId: "a1" };
    expect(sessionForShortcut(1, input)?.id).toBe("b1");
  });

  it("selects nothing with no project to count in", () => {
    const input = { sessions: rows, hidden: NONE, now: NOW, shownProjectId: null, activeSessionId: null };
    expect(sessionForShortcut(1, input)).toBeNull();
  });
});
