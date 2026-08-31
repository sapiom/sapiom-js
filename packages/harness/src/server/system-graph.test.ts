import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SystemGraphStore } from "../core/system-graph-store.js";
import type {
  SystemGraphBuilder,
  WorkspaceScopeResolver,
} from "../core/system-graph.js";
import {
  SYSTEM_GRAPH_CACHE_HEADER,
  type SystemGraph,
  type SystemGraphSnapshot,
} from "../shared/system-graph.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createSystemGraphRouter } from "./system-graph.js";

const workspaceKey = "workspace-known";
const graph: SystemGraph = {
  kind: "system",
  scope: { kind: "working-tree", workspaceKey },
  nodes: [
    { id: "agent:research", agentKey: "research", label: "Research" },
    { id: "agent:growth", agentKey: "growth", label: "Growth" },
  ],
  edges: [
    {
      from: "agent:research",
      to: "agent:growth",
      kind: "invokes",
      basis: "static",
      mode: "async",
    },
  ],
  warnings: [],
};

describe("createSystemGraphRouter", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  function start(cacheable = true, onScopeAccess = vi.fn()) {
    const scopeResolver: WorkspaceScopeResolver = {
      resolve: vi.fn(async (key: string) =>
        key === workspaceKey
          ? { workspaceKey: key, root: "/private/workspace" }
          : null,
      ),
    };
    const builder: SystemGraphBuilder = {
      build: vi.fn(async () => ({
        cacheable,
        graph,
        navigation: [
          { agentKey: "research", workflowPath: "/private/workspace/research" },
          { agentKey: "growth", workflowPath: "/private/workspace/growth" },
        ],
      })),
    };
    const store = new SystemGraphStore(builder);
    const app = express();
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use(
      "/api",
      createSystemGraphRouter({
        scopeResolver,
        store,
        onScopeAccess,
      }),
    );
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      scopeResolver,
      builder,
      store,
      onScopeAccess,
    };
  }

  it("is boot-token protected and returns the cached public graph", async () => {
    const { baseUrl, builder, onScopeAccess } = start();
    const route = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;

    expect((await fetch(route)).status).toBe(401);
    const first = await fetch(route, {
      headers: { "X-Harness-Token": "test-token" },
    });
    const second = await fetch(route, {
      headers: { "X-Harness-Token": "test-token" },
    });

    expect(first.status).toBe(200);
    expect(first.headers.get(SYSTEM_GRAPH_CACHE_HEADER)).toBe("complete");
    expect((await first.json()) as SystemGraphSnapshot).toEqual({
      workspaceKey,
      revision: 1,
      state: "ready",
      graph,
    });
    expect(second.status).toBe(200);
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(onScopeAccess).toHaveBeenCalledTimes(2);
  });

  it("reports degradation and bounds re-enrichment to one later request", async () => {
    const { baseUrl, builder } = start(false);
    const route = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;
    const request = () =>
      fetch(route, { headers: { "X-Harness-Token": "test-token" } });

    const first = await request();
    const second = await request();
    const third = await request();

    expect(first.headers.get(SYSTEM_GRAPH_CACHE_HEADER)).toBe("degraded");
    expect(second.headers.get(SYSTEM_GRAPH_CACHE_HEADER)).toBe("degraded");
    expect(third.headers.get(SYSTEM_GRAPH_CACHE_HEADER)).toBe("degraded");
    expect((await third.json()) as SystemGraphSnapshot).toMatchObject({
      workspaceKey,
      state: "degraded",
      graph,
    });
    expect(builder.build).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the projection through the protected explicit refresh route", async () => {
    const { baseUrl, builder } = start();
    const route = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;
    const headers = { "X-Harness-Token": "test-token" };
    await fetch(route, { headers });

    expect((await fetch(`${route}/refresh`, { method: "POST" })).status).toBe(
      401,
    );
    const refreshed = await fetch(`${route}/refresh`, {
      method: "POST",
      headers,
    });

    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()) as SystemGraphSnapshot).toMatchObject({
      workspaceKey,
      state: "ready",
      graph,
    });
    expect(builder.build).toHaveBeenCalledTimes(2);
  });

  it("serves a separately protected resolver stamped with the graph revision", async () => {
    const { baseUrl, builder } = start();
    const graphRoute = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;
    const navigationRoute = `${graphRoute}/navigation`;
    const headers = { "X-Harness-Token": "test-token" };
    const snapshot = (await (
      await fetch(graphRoute, { headers })
    ).json()) as SystemGraphSnapshot;

    expect((await fetch(navigationRoute)).status).toBe(401);
    const response = await fetch(navigationRoute, { headers });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      workspaceKey,
      revision: snapshot.revision,
      targets: [
        {
          agentKey: "research",
          workflowPath: "/private/workspace/research",
        },
        {
          agentKey: "growth",
          workflowPath: "/private/workspace/growth",
        },
      ],
    });
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it("serves degraded navigation without consuming a graph recovery retry", async () => {
    const { baseUrl, builder } = start(false);
    const graphRoute = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;
    const headers = { "X-Harness-Token": "test-token" };
    const snapshot = (await (
      await fetch(graphRoute, { headers })
    ).json()) as SystemGraphSnapshot;

    const navigation = await fetch(`${graphRoute}/navigation`, { headers });

    expect(navigation.status).toBe(200);
    expect(await navigation.json()).toMatchObject({
      workspaceKey,
      revision: snapshot.revision,
    });
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it("does not send a projection retired while its HTTP build is in flight", async () => {
    let resolveBuild!: (
      value: Awaited<ReturnType<SystemGraphBuilder["build"]>>,
    ) => void;
    const pending = new Promise<
      Awaited<ReturnType<SystemGraphBuilder["build"]>>
    >((resolve) => {
      resolveBuild = resolve;
    });
    const builder: SystemGraphBuilder = {
      build: vi.fn(() => pending),
    };
    const store = new SystemGraphStore(builder);
    const scopeResolver: WorkspaceScopeResolver = {
      resolve: vi.fn(async () => ({
        workspaceKey,
        root: "/private/workspace",
      })),
    };
    const app = express();
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use("/api", createSystemGraphRouter({ scopeResolver, store }));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    const response = fetch(
      `http://127.0.0.1:${address.port}/api/workspaces/${workspaceKey}/system-graph`,
      { headers: { "X-Harness-Token": "test-token" } },
    );
    await vi.waitFor(() => expect(builder.build).toHaveBeenCalledTimes(1));

    store.retire(workspaceKey);
    resolveBuild({
      cacheable: true,
      graph,
      navigation: [],
    });

    expect((await response).status).toBe(404);
  });

  it("serves the current accepted revision when afterCommit immediately refreshes", async () => {
    const builder: SystemGraphBuilder = {
      build: vi
        .fn()
        .mockResolvedValueOnce({
          cacheable: false,
          graph,
          navigation: [],
          afterCommit: () =>
            store.requestRefresh({
              workspaceKey,
              root: "/private/workspace",
            }),
        })
        .mockResolvedValueOnce({ cacheable: true, graph, navigation: [] }),
    };
    const store = new SystemGraphStore(builder);
    const app = express();
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use(
      "/api",
      createSystemGraphRouter({
        scopeResolver: {
          resolve: async () => ({
            workspaceKey,
            root: "/private/workspace",
          }),
        },
        store,
      }),
    );
    server = app.listen(0);
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/workspaces/${workspaceKey}/system-graph`,
      { headers: { "X-Harness-Token": "test-token" } },
    );
    const body = (await response.json()) as SystemGraphSnapshot;

    expect(response.status).toBe(200);
    expect(body.revision).toBe(store.peek(workspaceKey)?.revision);
    expect(body.revision).toBeGreaterThan(1);
  });

  it("rejects an unknown opaque workspace key without scanning", async () => {
    const { baseUrl, builder } = start();
    const response = await fetch(
      `${baseUrl}/api/workspaces/unknown/system-graph`,
      {
        headers: { "X-Harness-Token": "test-token" },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workspace not found" });
    expect(builder.build).not.toHaveBeenCalled();
    expect(
      (
        await fetch(
          `${baseUrl}/api/workspaces/unknown/system-graph/navigation`,
          { headers: { "X-Harness-Token": "test-token" } },
        )
      ).status,
    ).toBe(404);
  });
});
