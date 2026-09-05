import { describe, expect, it } from "vitest";

import {
  liveSessionsInProject,
  liveSessionsLabel,
  liveSessionsOnAgents,
} from "./project-live";
import type { ScopedSession } from "./session-scope";

const ACME = "/Users/demo/acme-app";
const LEASING = `${ACME}/leasing`;
const PRICING = `${ACME}/pricing`;
const RFQ = "/Users/demo/rfq-agent";

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

describe("liveSessionsInProject", () => {
  it("counts a session rooted at the project root", () => {
    const sessions = [session({ id: "a", cwd: ACME })];
    expect(liveSessionsInProject(sessions, ACME)).toHaveLength(1);
  });

  it("counts a session rooted in a subdirectory of the project", () => {
    const sessions = [session({ id: "a", cwd: LEASING })];
    expect(liveSessionsInProject(sessions, ACME)).toHaveLength(1);
  });

  it("counts a session bound to an agent in the project from outside it", () => {
    const sessions = [
      session({
        id: "a",
        cwd: "/Users/demo/elsewhere",
        boundWorkflowPath: LEASING,
      }),
    ];
    expect(liveSessionsInProject(sessions, ACME)).toHaveLength(1);
  });

  it("counts every live session, so the mark can say how many", () => {
    const sessions = [
      session({ id: "a", cwd: ACME }),
      session({ id: "b", cwd: ACME, status: "starting" }),
      session({ id: "c", cwd: LEASING }),
    ];
    expect(liveSessionsInProject(sessions, ACME)).toHaveLength(3);
  });

  it("does not count an exited session, so the mark goes with the last one", () => {
    const sessions = [session({ id: "a", cwd: ACME, status: "exited" })];
    expect(liveSessionsInProject(sessions, ACME)).toEqual([]);
  });

  it("drops the mark once the last live session exits, and not before", () => {
    const both = [
      session({ id: "a", cwd: ACME }),
      session({ id: "b", cwd: LEASING }),
    ];
    expect(liveSessionsInProject(both, ACME)).toHaveLength(2);

    const one = [
      both[0]!,
      session({ id: "b", cwd: LEASING, status: "exited" }),
    ];
    expect(liveSessionsInProject(one, ACME)).toHaveLength(1);

    const none = one.map((entry) => ({ ...entry, status: "exited" as const }));
    expect(liveSessionsInProject(none, ACME)).toEqual([]);
  });

  it("does not count another project's session", () => {
    const sessions = [session({ id: "a", cwd: RFQ })];
    expect(liveSessionsInProject(sessions, ACME)).toEqual([]);
  });

  it("refuses a bare string prefix: `acme-app-old` is not inside `acme-app`", () => {
    const sessions = [session({ id: "a", cwd: `${ACME}-old` })];
    expect(liveSessionsInProject(sessions, ACME)).toEqual([]);
  });

  it("counts nothing for an empty root, which prefixes every path", () => {
    const sessions = [session({ id: "a", cwd: ACME })];
    expect(liveSessionsInProject(sessions, "")).toEqual([]);
  });
});

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
