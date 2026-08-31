import { describe, expect, it } from "vitest";
import type {
  SystemGraphNavigationResponse,
  SystemGraphSnapshot,
} from "@shared/system-graph";

import { workspaceGraphNavigationIsCurrent } from "./WorkspaceGraphView";
import { systemGraphNavigationForSnapshot } from "../lib/system-graph-navigation";
import {
  retainSystemGraphAnnouncements,
  systemGraphAnnouncementsAfterMessage,
} from "../lib/system-graph-announcements";

describe("WorkspaceGraphView navigation lifecycle", () => {
  it("retains a graph announcement across a batched unrelated frame", () => {
    let announcements = new Map();
    announcements = systemGraphAnnouncementsAfterMessage(announcements, {
      type: "system-graph.changed",
      workspaceKey: "workspace-test",
      revision: 8,
      state: "stale",
    });
    announcements = systemGraphAnnouncementsAfterMessage(announcements, {
      type: "workflows.changed",
    });
    const incoming = announcements.get("workspace-test");

    expect(incoming).toMatchObject({ revision: 8, state: "stale" });
    expect(
      workspaceGraphNavigationIsCurrent({
        snapshotRevision: 7,
        snapshotState: "ready",
        announcementRevision: null,
        incomingRevision: incoming?.revision,
        loading: false,
        error: false,
      }),
    ).toBe(false);
  });

  it("retains the highest revision per active workspace", () => {
    let announcements = new Map();
    for (const message of [
      {
        type: "system-graph.changed" as const,
        workspaceKey: "workspace-one",
        revision: 3,
        state: "ready" as const,
      },
      {
        type: "system-graph.changed" as const,
        workspaceKey: "workspace-two",
        revision: 7,
        state: "degraded" as const,
      },
      {
        type: "system-graph.changed" as const,
        workspaceKey: "workspace-one",
        revision: 2,
        state: "stale" as const,
      },
    ]) {
      announcements = systemGraphAnnouncementsAfterMessage(
        announcements,
        message,
      );
    }

    expect(announcements.get("workspace-one")?.revision).toBe(3);
    expect(announcements.get("workspace-two")?.revision).toBe(7);
    expect(
      retainSystemGraphAnnouncements(
        announcements,
        new Set(["workspace-one", "workspace-two", "workspace-three"]),
      ),
    ).toBe(announcements);
    expect([
      ...retainSystemGraphAnnouncements(
        announcements,
        new Set(["workspace-two"]),
      ).keys(),
    ]).toEqual(["workspace-two"]);
  });

  it("fails closed before a newer deferred graph arrives and stays closed when it rejects", () => {
    const displayed = {
      snapshotRevision: 7,
      snapshotState: "ready" as const,
      announcementRevision: null,
      loading: false,
      error: false,
    };
    expect(workspaceGraphNavigationIsCurrent(displayed)).toBe(true);

    const announced = { ...displayed, announcementRevision: 8 };
    expect(workspaceGraphNavigationIsCurrent(announced)).toBe(false);
    expect(
      workspaceGraphNavigationIsCurrent({ ...announced, loading: true }),
    ).toBe(false);
    expect(
      workspaceGraphNavigationIsCurrent({
        ...announced,
        loading: false,
        error: true,
      }),
    ).toBe(false);
  });

  it("keeps a resolver-newer graph inert through catch-up failure", () => {
    expect(
      workspaceGraphNavigationIsCurrent({
        snapshotRevision: 7,
        snapshotState: "ready",
        announcementRevision: 8,
        loading: false,
        error: true,
      }),
    ).toBe(false);
  });

  it("fails closed when no recognized committed lifecycle state is present", () => {
    expect(
      workspaceGraphNavigationIsCurrent({
        snapshotRevision: 7,
        snapshotState: null,
        announcementRevision: null,
        loading: false,
        error: false,
      }),
    ).toBe(false);
  });

  it("is inert on the first render carrying a newer bus announcement", () => {
    expect(
      workspaceGraphNavigationIsCurrent({
        snapshotRevision: 7,
        snapshotState: "ready",
        announcementRevision: null,
        incomingRevision: 8,
        loading: false,
        error: false,
      }),
    ).toBe(false);
  });

  it("keeps a matching stale sidecar inert until projection settles", () => {
    const snapshot = (revision: number, state: "stale" | "degraded") =>
      ({
        workspaceKey: "workspace-test",
        revision,
        state,
        graph: {
          kind: "system",
          scope: {
            kind: "working-tree",
            workspaceKey: "workspace-test",
          },
          nodes: [{ id: "agent:a", agentKey: "a", label: "A" }],
          edges: [],
          warnings: [],
        },
      }) satisfies SystemGraphSnapshot;
    const response = (revision: number) =>
      ({
        workspaceKey: "workspace-test",
        revision,
        targets: [{ agentKey: "a", workflowPath: "/private/a" }],
      }) satisfies SystemGraphNavigationResponse;
    const stale = snapshot(8, "stale");
    const staleCurrent = workspaceGraphNavigationIsCurrent({
      snapshotRevision: stale.revision,
      snapshotState: stale.state,
      announcementRevision: 8,
      loading: false,
      error: false,
    });
    const staleNavigation = staleCurrent
      ? systemGraphNavigationForSnapshot(response(8), stale)
      : new Map();
    expect(staleNavigation.size).toBe(0);

    const degraded = snapshot(9, "degraded");
    const degradedCurrent = workspaceGraphNavigationIsCurrent({
      snapshotRevision: degraded.revision,
      snapshotState: degraded.state,
      announcementRevision: 8,
      loading: false,
      error: false,
    });
    const degradedNavigation = degradedCurrent
      ? systemGraphNavigationForSnapshot(response(9), degraded)
      : new Map();
    expect([...degradedNavigation]).toEqual([["a", "/private/a"]]);
  });
});
