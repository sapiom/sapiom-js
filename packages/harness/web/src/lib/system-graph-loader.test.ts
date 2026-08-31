import { describe, expect, it, vi } from "vitest";

import type {
  SystemGraph,
  SystemGraphLifecycleState,
  SystemGraphSnapshot,
  WorkspaceKey,
} from "@shared/system-graph";

import {
  createSystemGraphLoader,
  type SystemGraphSource,
} from "./system-graph-loader";

const workspaceKey: WorkspaceKey = "workspace-test";
const graph: SystemGraph = {
  kind: "system",
  scope: { kind: "working-tree", workspaceKey },
  nodes: [],
  edges: [],
  warnings: [],
};

const snapshot = (
  revision: number,
  state: SystemGraphLifecycleState = "ready",
): SystemGraphSnapshot => ({ workspaceKey, revision, state, graph });

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("createSystemGraphLoader", () => {
  it("coalesces requests and retains a ready snapshot", async () => {
    const ready = snapshot(1);
    const getSystemGraph = vi.fn(async () => ready);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    const first = loader.load(source, workspaceKey);
    expect(loader.load(source, workspaceKey)).toBe(first);
    await expect(first).resolves.toBe(ready);
    expect(loader.load(source, workspaceKey)).toBe(first);
    expect(getSystemGraph).toHaveBeenCalledTimes(1);
  });

  it("allows one later-open retry and retains a second degraded snapshot", async () => {
    const degraded = snapshot(1, "degraded");
    const getSystemGraph = vi.fn(async () => degraded);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    const first = loader.load(source, workspaceKey);
    expect(loader.load(source, workspaceKey)).toBe(first);
    await expect(first).resolves.toBe(degraded);

    const second = loader.load(source, workspaceKey);
    await expect(second).resolves.toBe(degraded);
    expect(loader.load(source, workspaceKey)).toBe(second);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });

  it("allows one later-open retry for a stale last-known snapshot", async () => {
    const stale = snapshot(2, "stale");
    const ready = snapshot(3);
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(ready);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    await expect(loader.load(source, workspaceKey)).resolves.toBe(stale);
    await expect(loader.load(source, workspaceKey)).resolves.toBe(ready);

    expect(loader.peek(workspaceKey)).toBe(ready);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });

  it("does not retain an initial building response forever", async () => {
    const building: SystemGraphSnapshot = {
      workspaceKey,
      revision: 0,
      state: "building",
      graph: null,
    };
    const ready = snapshot(1);
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(building)
      .mockResolvedValueOnce(ready);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    await expect(loader.load(source, workspaceKey)).resolves.toBe(building);
    await expect(loader.load(source, workspaceKey)).resolves.toBe(ready);

    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected request without consuming the degraded retry", async () => {
    const ready = snapshot(1);
    const getSystemGraph = vi
      .fn()
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce(ready);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    await expect(loader.load(source, workspaceKey)).rejects.toThrow(
      "scan failed",
    );
    await expect(loader.load(source, workspaceKey)).resolves.toBe(ready);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });

  it("forces a network request for an explicit retry at the same revision", async () => {
    const degraded = snapshot(1, "degraded");
    const ready = snapshot(1);
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(degraded)
      .mockResolvedValueOnce(ready);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };
    await loader.load(source, workspaceKey);

    expect(loader.invalidate(workspaceKey)).toBe(true);
    await expect(loader.load(source, workspaceKey)).resolves.toBe(ready);

    expect(loader.peek(workspaceKey)).toBe(ready);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
    expect(getSystemGraph).toHaveBeenNthCalledWith(1, workspaceKey);
    expect(getSystemGraph).toHaveBeenNthCalledWith(2, workspaceKey, {
      refresh: true,
    });
  });

  it("accepts an explicit retry response after its lifecycle announcements", async () => {
    const pending = deferred<SystemGraphSnapshot>();
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1, "degraded"))
      .mockReturnValueOnce(pending.promise);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };
    await loader.load(source, workspaceKey);

    loader.invalidate(workspaceKey);
    const retry = loader.load(source, workspaceKey);
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(2));
    loader.invalidate(workspaceKey, 2);
    pending.resolve(snapshot(2));

    await expect(retry).resolves.toEqual(snapshot(2));
    await expect(loader.load(source, workspaceKey)).resolves.toEqual(
      snapshot(2),
    );
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });

  it("coalesces a Retry POST with the revision event it emits", async () => {
    const pending = deferred<SystemGraphSnapshot>();
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1, "degraded"))
      .mockReturnValueOnce(pending.promise);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };
    await loader.load(source, workspaceKey);

    loader.invalidate(workspaceKey);
    const retry = loader.load(source, workspaceKey);
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(2));
    loader.invalidate(workspaceKey, 2);
    const eventLoad = loader.load(source, workspaceKey);

    expect(eventLoad).toBe(retry);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
    pending.resolve(snapshot(2));
    await expect(retry).resolves.toEqual(snapshot(2));
    await expect(eventLoad).resolves.toEqual(snapshot(2));
    expect(loader.peek(workspaceKey)).toEqual(snapshot(2));
  });

  it("never lets an older in-flight response overwrite a newer revision", async () => {
    const oldRequest = deferred<SystemGraphSnapshot>();
    const newRequest = deferred<SystemGraphSnapshot>();
    const getSystemGraph = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    const first = loader.load(source, workspaceKey);
    expect(loader.invalidate(workspaceKey, 2)).toBe(true);
    const second = loader.load(source, workspaceKey);
    oldRequest.resolve(snapshot(1));
    newRequest.resolve(snapshot(2));

    await expect(first).resolves.toEqual(snapshot(2));
    await expect(second).resolves.toEqual(snapshot(2));
    expect(loader.peek(workspaceKey)).toEqual(snapshot(2));
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });

  it("accepts an in-flight response that already matches a new announcement", async () => {
    const pending = deferred<SystemGraphSnapshot>();
    const getSystemGraph = vi.fn(() => pending.promise);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    const first = loader.load(source, workspaceKey);
    expect(loader.invalidate(workspaceKey, 2)).toBe(true);
    pending.resolve(snapshot(2));

    await expect(first).resolves.toEqual(snapshot(2));
    await expect(loader.load(source, workspaceKey)).resolves.toEqual(
      snapshot(2),
    );
    expect(getSystemGraph).toHaveBeenCalledTimes(1);
  });

  it("does not let an older explicit retry overwrite a newer retry", async () => {
    const olderRetry = deferred<SystemGraphSnapshot>();
    const newerRetry = deferred<SystemGraphSnapshot>();
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockReturnValueOnce(olderRetry.promise)
      .mockReturnValueOnce(newerRetry.promise);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };
    await loader.load(source, workspaceKey);

    loader.invalidate(workspaceKey);
    const older = loader.load(source, workspaceKey);
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(2));
    loader.invalidate(workspaceKey);
    const newer = loader.load(source, workspaceKey);
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(3));
    newerRetry.resolve(snapshot(3));
    await expect(newer).resolves.toEqual(snapshot(3));
    olderRetry.resolve(snapshot(2));

    await expect(older).resolves.toEqual(snapshot(3));
    expect(loader.peek(workspaceKey)).toEqual(snapshot(3));
  });

  it("keeps a late event reload behind a newer explicit retry", async () => {
    const eventReload = deferred<SystemGraphSnapshot>();
    const explicitRetry = deferred<SystemGraphSnapshot>();
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockReturnValueOnce(eventReload.promise)
      .mockReturnValueOnce(explicitRetry.promise);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };
    await loader.load(source, workspaceKey);

    loader.invalidate(workspaceKey, 2);
    const announced = loader.load(source, workspaceKey);
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(2));
    loader.invalidate(workspaceKey);
    const retried = loader.load(source, workspaceKey);
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(3));
    explicitRetry.resolve(snapshot(3));
    await expect(retried).resolves.toEqual(snapshot(3));
    eventReload.resolve(snapshot(2));

    await expect(announced).resolves.toEqual(snapshot(3));
    expect(loader.peek(workspaceKey)).toEqual(snapshot(3));
  });

  it("does not let an announced response consume an unclaimed explicit retry", async () => {
    const announcedResponse = deferred<SystemGraphSnapshot>();
    const explicitResponse = deferred<SystemGraphSnapshot>();
    const getSystemGraph = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockReturnValueOnce(announcedResponse.promise)
      .mockReturnValueOnce(explicitResponse.promise);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };
    await loader.load(source, workspaceKey);

    loader.invalidate(workspaceKey, 2);
    const announced = loader.load(source, workspaceKey);
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(2));
    loader.invalidate(workspaceKey);
    announcedResponse.resolve(snapshot(2));
    await vi.waitFor(() => expect(getSystemGraph).toHaveBeenCalledTimes(3));
    expect(getSystemGraph).toHaveBeenNthCalledWith(3, workspaceKey, {
      refresh: true,
    });
    explicitResponse.resolve(snapshot(3));

    await expect(announced).resolves.toEqual(snapshot(3));
    expect(loader.peek(workspaceKey)).toEqual(snapshot(3));
  });

  it("ignores old announcements and invalidates only their workspace", async () => {
    const otherKey = "workspace-other";
    let otherRevision = 3;
    const getSystemGraph = vi.fn(async (key: WorkspaceKey) => ({
      ...snapshot(key === otherKey ? otherRevision : 3),
      workspaceKey: key,
      graph: {
        ...graph,
        scope: { kind: "working-tree" as const, workspaceKey: key },
      },
    }));
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };
    await Promise.all([
      loader.load(source, workspaceKey),
      loader.load(source, otherKey),
    ]);

    expect(loader.invalidate(workspaceKey, 3)).toBe(false);
    expect(loader.invalidate(otherKey, 4)).toBe(true);
    otherRevision = 4;
    await loader.load(source, workspaceKey);
    await loader.load(source, otherKey);

    expect(getSystemGraph).toHaveBeenCalledTimes(3);
  });

  it("retires removed workspace snapshots and does not retain late responses", async () => {
    const late = deferred<SystemGraphSnapshot>();
    const ready = snapshot(2);
    const getSystemGraph = vi
      .fn()
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(ready);
    const loader = createSystemGraphLoader();
    const source: SystemGraphSource = { getSystemGraph };

    const retiredRequest = loader.load(source, workspaceKey);
    loader.retain(new Set());
    await expect(loader.load(source, workspaceKey)).resolves.toBe(ready);
    late.resolve(snapshot(1));
    await retiredRequest;
    expect(loader.peek(workspaceKey)).toBe(ready);
    expect(getSystemGraph).toHaveBeenCalledTimes(2);
  });
});
