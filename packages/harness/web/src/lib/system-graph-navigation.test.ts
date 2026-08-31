import { describe, expect, it, vi } from "vitest";
import type {
  SystemGraphNavigationResponse,
  SystemGraphSnapshot,
} from "@shared/system-graph";

import {
  resolveSystemGraphNavigationForRevision,
  systemGraphNavigationForSnapshot,
} from "./system-graph-navigation";

const snapshot: SystemGraphSnapshot = {
  workspaceKey: "workspace-root",
  revision: 7,
  state: "ready",
  graph: {
    kind: "system",
    scope: { kind: "working-tree", workspaceKey: "workspace-root" },
    nodes: [
      { id: "agent:canonical", agentKey: "canonical", label: "Canonical" },
      {
        id: "agent:local:pending",
        agentKey: "local:pending",
        label: "Pending",
      },
    ],
    edges: [],
    warnings: [],
  },
};

function response(
  overrides: Partial<SystemGraphNavigationResponse> = {},
): SystemGraphNavigationResponse {
  return {
    workspaceKey: snapshot.workspaceKey,
    revision: snapshot.revision,
    targets: [
      { agentKey: "canonical", workflowPath: "/repo/canonical" },
      { agentKey: "local:pending", workflowPath: "/repo/pending" },
    ],
    ...overrides,
  };
}

describe("systemGraphNavigationForSnapshot", () => {
  it("maps canonical and provisional server-owned targets", () => {
    expect([...systemGraphNavigationForSnapshot(response(), snapshot)]).toEqual(
      [
        ["canonical", "/repo/canonical"],
        ["local:pending", "/repo/pending"],
      ],
    );
  });

  it("fails closed for a different workspace or revision", () => {
    expect(
      systemGraphNavigationForSnapshot(
        response({ workspaceKey: "workspace-other" }),
        snapshot,
      ).size,
    ).toBe(0);
    expect(
      systemGraphNavigationForSnapshot(response({ revision: 8 }), snapshot)
        .size,
    ).toBe(0);
  });

  it("does not accept a resolver target absent from graph JSON", () => {
    expect(
      systemGraphNavigationForSnapshot(
        response({
          targets: [
            { agentKey: "canonical", workflowPath: "/repo/canonical" },
            { agentKey: "ghost", workflowPath: "/private/ghost" },
          ],
        }),
        snapshot,
      ),
    ).toEqual(new Map([["canonical", "/repo/canonical"]]));
  });
});

describe("resolveSystemGraphNavigationForRevision", () => {
  it("retries a resolver that lost a commit race and accepts the matching revision", async () => {
    const stale = response({ revision: snapshot.revision - 1 });
    const matching = response();
    const getSystemGraphNavigation = vi
      .fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(matching);

    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation },
        snapshot.workspaceKey,
        snapshot.revision,
      ),
    ).resolves.toEqual({ kind: "matched", response: matching });
    expect(getSystemGraphNavigation).toHaveBeenCalledTimes(2);
  });

  it("waits between attempts so a behind resolver can catch its commit up", async () => {
    const waits: number[] = [];
    const stale = response({ revision: snapshot.revision - 1 });
    const matching = response();
    const getSystemGraphNavigation = vi
      .fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(matching);

    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation },
        snapshot.workspaceKey,
        snapshot.revision,
        undefined,
        async (attempt) => {
          waits.push(attempt);
        },
      ),
    ).resolves.toEqual({ kind: "matched", response: matching });
    expect(getSystemGraphNavigation).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([0, 1]);
  });

  it("tells the view to advance when the resolver has the newer committed revision", async () => {
    const getSystemGraphNavigation = vi.fn(async () =>
      response({ revision: snapshot.revision + 1 }),
    );

    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation },
        snapshot.workspaceKey,
        snapshot.revision,
      ),
    ).resolves.toEqual({
      kind: "graph-behind",
      revision: snapshot.revision + 1,
    });
  });

  it("fails closed for foreign, repeatedly stale, and rejected responses", async () => {
    const foreign = vi.fn(async () =>
      response({ workspaceKey: "workspace-other" }),
    );
    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation: foreign },
        snapshot.workspaceKey,
        snapshot.revision,
      ),
    ).resolves.toEqual({ kind: "unavailable" });

    const stale = vi.fn(async () =>
      response({ revision: snapshot.revision - 1 }),
    );
    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation: stale },
        snapshot.workspaceKey,
        snapshot.revision,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(stale).toHaveBeenCalledTimes(3);

    const rejected = vi.fn(async () => {
      throw new Error("resolver unavailable");
    });
    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation: rejected },
        snapshot.workspaceKey,
        snapshot.revision,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(rejected).toHaveBeenCalledTimes(3);
  });

  it("recovers from a transient resolver rejection within the bounded loop", async () => {
    const matching = response();
    const getSystemGraphNavigation = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(matching);

    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation },
        snapshot.workspaceKey,
        snapshot.revision,
      ),
    ).resolves.toEqual({ kind: "matched", response: matching });
    expect(getSystemGraphNavigation).toHaveBeenCalledTimes(2);
  });

  it("stops resolver retries when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const getSystemGraphNavigation = vi.fn(async () => response());

    await expect(
      resolveSystemGraphNavigationForRevision(
        { getSystemGraphNavigation },
        snapshot.workspaceKey,
        snapshot.revision,
        controller.signal,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(getSystemGraphNavigation).not.toHaveBeenCalled();
  });
});
