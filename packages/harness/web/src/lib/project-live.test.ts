import { describe, expect, it } from "vitest";

import { liveSessionsLabel, liveSessionsOnAgents } from "./project-live";
import type { ScopedSession } from "./session-scope";

const ACME = "/Users/demo/acme-app";
const LEASING = `${ACME}/leasing`;
const PRICING = `${ACME}/pricing`;

/** A session with only the fields these rules read. `createdAt` is required by
 *  `ScopedSession` and is never consulted here: the mark counts, it does not
 *  order. */
function session(over: Partial<ScopedSession> & { id: string }): ScopedSession {
  return {
    cwd: ACME,
    status: "running",
    boundWorkflowPath: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    ...over,
  };
}

describe("liveSessionsOnAgents", () => {
  it("counts a session bound to a member", () => {
    const sessions = [
      session({ id: "a", cwd: ACME, boundWorkflowPath: LEASING }),
    ];
    expect(liveSessionsOnAgents(sessions, [LEASING])).toHaveLength(1);
  });

  it("counts an unbound session sitting in a member's own folder", () => {
    const sessions = [session({ id: "a", cwd: LEASING })];
    expect(liveSessionsOnAgents(sessions, [LEASING])).toHaveLength(1);
  });

  it("does not count an unbound session at the project root above the members", () => {
    // The group is a label over agents, not a directory: a session at the
    // project root is in no member's folder and belongs to no group.
    const sessions = [session({ id: "a", cwd: ACME })];
    expect(liveSessionsOnAgents(sessions, [LEASING, PRICING])).toEqual([]);
  });

  it("does not count a session bound to an agent outside the group", () => {
    const sessions = [
      session({ id: "a", cwd: ACME, boundWorkflowPath: PRICING }),
    ];
    expect(liveSessionsOnAgents(sessions, [LEASING])).toEqual([]);
  });

  it("does not count an exited session on a member", () => {
    const sessions = [
      session({
        id: "a",
        cwd: ACME,
        boundWorkflowPath: LEASING,
        status: "exited",
      }),
    ];
    expect(liveSessionsOnAgents(sessions, [LEASING])).toEqual([]);
  });

  it("matches paths, not strings: a trailing separator is the same folder", () => {
    const sessions = [
      session({ id: "a", cwd: ACME, boundWorkflowPath: `${LEASING}/` }),
    ];
    expect(liveSessionsOnAgents(sessions, [LEASING])).toHaveLength(1);
  });

  it("drops the mark once the last live member session exits, and not before", () => {
    const both = [
      session({ id: "a", cwd: ACME, boundWorkflowPath: LEASING }),
      session({ id: "b", cwd: PRICING }),
    ];
    expect(liveSessionsOnAgents(both, [LEASING, PRICING])).toHaveLength(2);

    const one = [
      both[0]!,
      session({ id: "b", cwd: PRICING, status: "exited" }),
    ];
    expect(liveSessionsOnAgents(one, [LEASING, PRICING])).toHaveLength(1);

    const none = one.map((entry) => ({ ...entry, status: "exited" as const }));
    expect(liveSessionsOnAgents(none, [LEASING, PRICING])).toEqual([]);
  });

  it("counts a starting session, which is about to be running", () => {
    const sessions = [
      session({
        id: "a",
        cwd: ACME,
        boundWorkflowPath: LEASING,
        status: "starting",
      }),
    ];
    expect(liveSessionsOnAgents(sessions, [LEASING])).toHaveLength(1);
  });

  it("counts nothing for a group with no members", () => {
    const sessions = [session({ id: "a", cwd: LEASING })];
    expect(liveSessionsOnAgents(sessions, [])).toEqual([]);
  });
});

describe("liveSessionsLabel", () => {
  it("names one session in the singular", () => {
    expect(liveSessionsLabel(1)).toBe("1 live session");
  });

  it("names several in the plural", () => {
    expect(liveSessionsLabel(4)).toBe("4 live sessions");
  });
});
