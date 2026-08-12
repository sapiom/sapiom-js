/**
 * Unit coverage for the Overview panel's workspace list. The bug this replaces
 * was not a rendering bug — the panel rendered `settings.recentDirs` perfectly.
 * It was a *sourcing* bug, so the tests worth having are about which
 * directories qualify and in what order.
 */
import { describe, expect, it } from "vitest";
import type { HarnessSession, WorkflowInfo } from "@shared/types";

import { recentWorkspaces, unlistedAgentCount } from "./recent-workspaces";

const session = (overrides: Partial<HarnessSession>): HarnessSession => ({
  id: "sess-1",
  agentSessionId: null,
  harness: "claude-code",
  cwd: "/home/dev/app",
  title: "app",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  boundWorkflowPath: null,
  ready: true,
  ...overrides,
});

const workflow = (path: string): WorkflowInfo => ({
  name: path.split("/").pop() ?? path,
  path,
  definitionId: null,
  definitionSlug: null,
  source: "scan",
});

describe("recentWorkspaces", () => {
  it("lists every directory a session ran in, not just the launch dir", () => {
    // The actual defect: one launch dir in recentDirs, several worked-in
    // folders in the registry, and the panel showed only the former.
    const result = recentWorkspaces(
      [
        session({ id: "a", cwd: "/home/dev/alpha", lastActiveAt: "2026-01-02T00:00:00.000Z" }),
        session({ id: "b", cwd: "/home/dev/beta", lastActiveAt: "2026-01-03T00:00:00.000Z" }),
      ],
      ["/home/dev/launch"],
      [],
    );

    expect(result.map((entry) => entry.cwd)).toEqual([
      "/home/dev/beta",
      "/home/dev/alpha",
      "/home/dev/launch",
    ]);
  });

  it("counts exited sessions — a folder you finished in is still recent", () => {
    const result = recentWorkspaces(
      [session({ cwd: "/home/dev/done", status: "exited" })],
      [],
      [],
    );

    expect(result.map((entry) => entry.cwd)).toEqual(["/home/dev/done"]);
  });

  it("collapses many sessions in one folder to a single row at its freshest time", () => {
    const result = recentWorkspaces(
      [
        session({ id: "a", cwd: "/home/dev/app", lastActiveAt: "2026-01-01T00:00:00.000Z" }),
        session({ id: "b", cwd: "/home/dev/app", lastActiveAt: "2026-01-09T00:00:00.000Z" }),
        session({ id: "c", cwd: "/home/dev/app", lastActiveAt: "2026-01-05T00:00:00.000Z" }),
      ],
      [],
      [],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.lastActiveAt).toBe("2026-01-09T00:00:00.000Z");
  });

  it("ranks session activity above launch dirs, whatever recentDirs says", () => {
    // recentDirs is newest-first, but a launch dir carries no activity time at
    // all — it can't outrank a folder something actually ran in.
    const result = recentWorkspaces(
      [session({ cwd: "/home/dev/worked-in", lastActiveAt: "2020-01-01T00:00:00.000Z" })],
      ["/home/dev/just-launched"],
      [],
    );

    expect(result.map((entry) => entry.cwd)).toEqual([
      "/home/dev/worked-in",
      "/home/dev/just-launched",
    ]);
    expect(result[1]?.lastActiveAt).toBeNull();
  });

  it("keeps recentDirs order among launch-only dirs and never duplicates a folder", () => {
    const result = recentWorkspaces(
      [session({ cwd: "/home/dev/shared" })],
      ["/home/dev/shared", "/home/dev/first", "/home/dev/second", "/home/dev/first"],
      [],
    );

    expect(result.map((entry) => entry.cwd)).toEqual([
      "/home/dev/shared", // from the registry, with its timestamp — not repeated below
      "/home/dev/first",
      "/home/dev/second",
    ]);
  });

  it("breaks identical timestamps on path so the list never reshuffles", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const result = recentWorkspaces(
      [
        session({ id: "b", cwd: "/home/dev/b", lastActiveAt: at }),
        session({ id: "a", cwd: "/home/dev/a", lastActiveAt: at }),
      ],
      [],
      [],
    );

    expect(result.map((entry) => entry.cwd)).toEqual(["/home/dev/a", "/home/dev/b"]);
  });

  it("counts agent projects at or under a folder, and only real descendants", () => {
    const result = recentWorkspaces(
      [session({ cwd: "/home/dev/acme" })],
      ["/home/dev/scratch"],
      [
        workflow("/home/dev/acme"), // the folder itself is a project
        workflow("/home/dev/acme/leasing"), // nested project
        workflow("/home/dev/acme-two/other"), // sibling: prefix-alike, NOT under it
      ],
    );

    expect(result[0]?.agentCount).toBe(2);
    // A bare folder is still a workspace — it just has no agents in it yet.
    expect(result[1]).toMatchObject({ cwd: "/home/dev/scratch", agentCount: 0 });
  });

  it("labels rows with the folder name", () => {
    const result = recentWorkspaces([session({ cwd: "/home/dev/my-project" })], [], []);

    expect(result[0]?.label).toBe("my-project");
  });

  it("labels Windows cwds by basename and counts agents under mixed-separator paths", () => {
    const result = recentWorkspaces(
      [session({ cwd: "C:\\Users\\demo\\alpha" })],
      [],
      // Mixed form — a `/`-joined child of a native Windows folder (the
      // shipped bug's shape) must still count as a descendant.
      [workflow("C:\\Users\\demo\\alpha/leasing"), workflow("C:\\Users\\demo\\alpha-2\\rfq")],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("alpha");
    expect(result[0]?.agentCount).toBe(1);
  });

  it("returns nothing when nothing is known", () => {
    expect(recentWorkspaces([], [], [])).toEqual([]);
  });
});

describe("unlistedAgentCount", () => {
  const shown = (agentCount: number): ReturnType<typeof recentWorkspaces>[number] => ({
    cwd: `/home/dev/w${agentCount}`,
    label: `w${agentCount}`,
    lastActiveAt: null,
    agentCount,
  });

  it("counts the agents the visible rows leave out — the 1-of-56 case", () => {
    // The user-reported shape: one workspace row on Overview, a registry full of
    // projects the rail can see and this list cannot.
    const workflows = Array.from({ length: 56 }, (_, i) => workflow(`/home/dev/p${i}`));

    expect(unlistedAgentCount(workflows, [shown(1)])).toBe(55);
  });

  it("is zero when the rows account for everything, so no note is claimed", () => {
    expect(unlistedAgentCount([workflow("/a"), workflow("/b")], [shown(2)])).toBe(0);
  });

  it("floors at zero when nesting double-counts an agent", () => {
    // A launch dir listed alongside a project inside it counts that project
    // twice. Better to under-report (no note) than to render "-1 projects".
    expect(unlistedAgentCount([workflow("/a")], [shown(1), shown(1)])).toBe(0);
  });

  it("is zero when the registry is empty", () => {
    expect(unlistedAgentCount([], [shown(0)])).toBe(0);
  });
});
