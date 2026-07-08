import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createMacrosRouter, type MacrosRouterDeps } from "./macros.js";
import { DEFAULT_MACROS } from "../core/macros.js";
import type { WorkflowInfo } from "../shared/types.js";

let server: Server;
let baseUrl: string;

const workflow: WorkflowInfo = {
  name: "leasing",
  path: "/Users/demo/acme-app/leasing",
  definitionId: 4821,
  source: "scan",
};

function makeDeps(overrides: Partial<MacrosRouterDeps> = {}): MacrosRouterDeps {
  return {
    listMacros: () => DEFAULT_MACROS,
    findWorkflow: (p) => (p === workflow.path ? workflow : null),
    getSessionCwd: (id) => (id === "sess-1" ? "/Users/demo/acme-app" : null),
    injectInput: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function start(deps: MacrosRouterDeps): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createMacrosRouter(deps));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

async function stop(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("macros router", () => {
  afterEach(async () => {
    await stop();
  });

  it("GET /api/macros returns the configured macro list", async () => {
    await start(makeDeps());
    const res = await fetch(`${baseUrl}/api/macros`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_MACROS);
  });

  it("POST /api/macros/:id/run injects the resolved text for an inject macro", async () => {
    const deps = makeDeps();
    await start(deps);

    const res = await fetch(`${baseUrl}/api/macros/deploy/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1", workflowPath: workflow.path }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deps.injectInput).toHaveBeenCalledWith(
      "sess-1",
      "cd /Users/demo/acme-app/leasing && sapiom agents deploy",
      true,
    );
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it("opens the resolved URL for an open-url macro", async () => {
    const deps = makeDeps();
    await start(deps);

    const res = await fetch(`${baseUrl}/api/macros/open_prod/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1", workflowPath: workflow.path }),
    });

    expect(res.status).toBe(200);
    expect(deps.openUrl).toHaveBeenCalledWith("https://app.sapiom.ai/agents/4821");
    expect(deps.injectInput).not.toHaveBeenCalled();
  });

  it("400s a workflow-required macro run without a workflowPath", async () => {
    await start(makeDeps());
    const res = await fetch(`${baseUrl}/api/macros/deploy/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("requires a selected workflow");
  });

  it("404s an unknown macro id", async () => {
    await start(makeDeps());
    const res = await fetch(`${baseUrl}/api/macros/does-not-exist/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a run request missing harnessSessionId", async () => {
    await start(makeDeps());
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "the leasing funnel" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s a run request for an unknown session", async () => {
    await start(makeDeps());
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "no-such-session", subject: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("runs a workflow-optional macro (visualize) without a workflowPath", async () => {
    const deps = makeDeps();
    await start(deps);
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1", subject: "the leasing funnel" }),
    });
    expect(res.status).toBe(200);
    expect(deps.injectInput).toHaveBeenCalledWith(
      "sess-1",
      "Write a live HTML visualization of the leasing funnel to .sapiom/canvas/index.html and keep it updated as things change.",
      true,
    );
  });
});
