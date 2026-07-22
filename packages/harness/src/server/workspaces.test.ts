/**
 * Workspaces router tests — exercise the HTTP surface end-to-end against a
 * real WorkspaceStore backed by an isolated tmp file (no network, no real
 * home). express.json() is mounted ahead of the router exactly as the real
 * server does for /api (server/index.ts).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceStore } from "../core/workspace-store.js";
import type { Workspace } from "../shared/types.js";
import { createWorkspacesRouter } from "./workspaces.js";

let tmpRoot: string;
let store: WorkspaceStore;
let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;

function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createWorkspacesRouter(store));
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspaces-router-"));
  store = new WorkspaceStore(path.join(tmpRoot, "workspaces.json"));
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/workspaces", () => {
  it("returns an empty array initially", async () => {
    const res = await api("GET", "/api/workspaces");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /api/workspaces", () => {
  it("creates a workspace and returns 201", async () => {
    const res = await api("POST", "/api/workspaces", { name: "acme" });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as Workspace;
    expect(ws.name).toBe("acme");
    expect(ws.agentPaths).toEqual([]);
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("400s when name is missing or blank", async () => {
    expect((await api("POST", "/api/workspaces", {})).status).toBe(400);
    expect((await api("POST", "/api/workspaces", { name: "   " })).status).toBe(400);
  });
});

describe("PATCH /api/workspaces/:id", () => {
  it("renames a workspace", async () => {
    const created = (await (await api("POST", "/api/workspaces", { name: "old" })).json()) as Workspace;
    const res = await api("PATCH", `/api/workspaces/${created.id}`, { name: "new" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Workspace).name).toBe("new");
  });

  it("404s for an unknown id", async () => {
    const res = await api("PATCH", "/api/workspaces/nope", { name: "x" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("UNKNOWN_WORKSPACE");
  });

  it("400s for a blank name", async () => {
    const created = (await (await api("POST", "/api/workspaces", { name: "keep" })).json()) as Workspace;
    expect((await api("PATCH", `/api/workspaces/${created.id}`, { name: "" })).status).toBe(400);
  });
});

describe("DELETE /api/workspaces/:id", () => {
  it("deletes a workspace", async () => {
    const created = (await (await api("POST", "/api/workspaces", { name: "gone" })).json()) as Workspace;
    const res = await api("DELETE", `/api/workspaces/${created.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await (await api("GET", "/api/workspaces")).json()).toEqual([]);
  });

  it("404s for an unknown id", async () => {
    expect((await api("DELETE", "/api/workspaces/nope")).status).toBe(404);
  });
});

describe("agent membership", () => {
  it("assigns and unassigns an agent by path", async () => {
    const created = (await (await api("POST", "/api/workspaces", { name: "w" })).json()) as Workspace;

    const assigned = (await (
      await api("POST", `/api/workspaces/${created.id}/agents`, { agentPath: "/repos/crm" })
    ).json()) as Workspace;
    expect(assigned.agentPaths).toEqual(["/repos/crm"]);

    const unassigned = (await (
      await api("DELETE", `/api/workspaces/${created.id}/agents`, { agentPath: "/repos/crm" })
    ).json()) as Workspace;
    expect(unassigned.agentPaths).toEqual([]);
  });

  it("400s when agentPath is missing", async () => {
    const created = (await (await api("POST", "/api/workspaces", { name: "w" })).json()) as Workspace;
    expect((await api("POST", `/api/workspaces/${created.id}/agents`, {})).status).toBe(400);
  });

  it("404s when assigning to an unknown workspace", async () => {
    const res = await api("POST", "/api/workspaces/nope/agents", { agentPath: "/repos/x" });
    expect(res.status).toBe(404);
  });
});

describe("persistence through the API", () => {
  it("a workspace created via POST is readable by a fresh store instance", async () => {
    const created = (await (await api("POST", "/api/workspaces", { name: "persisted" })).json()) as Workspace;
    await api("POST", `/api/workspaces/${created.id}/agents`, { agentPath: "/repos/a" });

    const reloaded = new WorkspaceStore(path.join(tmpRoot, "workspaces.json"));
    const list = await reloaded.list();
    expect(list).toHaveLength(1);
    expect(list[0].agentPaths).toEqual(["/repos/a"]);
  });
});
