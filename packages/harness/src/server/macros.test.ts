import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createMacrosRouter, type MacrosRouterDeps } from "./macros.js";
import { DEFAULT_MACROS } from "../core/macros.js";
import { SessionNotReadyError } from "../core/session-manager.js";
import { TaskAlreadyRunningError, TaskNotSupportedError } from "../core/task-manager.js";
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
    getBoundWorkflowPath: () => null,
    injectInput: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn().mockResolvedValue(undefined),
    renderCanvas: vi.fn().mockResolvedValue(undefined),
    runBackgroundTask: vi.fn().mockResolvedValue(undefined),
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
    expect(deps.openUrl).toHaveBeenCalledWith("https://app.sapiom.ai/workflows/4821");
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
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s a run request for an unknown session", async () => {
    await start(makeDeps());
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "no-such-session" }),
    });
    expect(res.status).toBe(404);
  });

  it("falls back to the session's bound workflow when the request omits workflowPath", async () => {
    const deps = makeDeps({ getBoundWorkflowPath: (id) => (id === "sess-1" ? workflow.path : null) });
    await start(deps);

    const res = await fetch(`${baseUrl}/api/macros/deploy/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }), // no workflowPath
    });

    expect(res.status).toBe(200);
    expect(deps.injectInput).toHaveBeenCalledWith(
      "sess-1",
      "cd /Users/demo/acme-app/leasing && sapiom agents deploy",
      true,
    );
  });

  it("prefers an explicit workflowPath on the request over the session's bound workflow", async () => {
    const otherWorkflow: WorkflowInfo = { name: "rfq", path: "/Users/demo/acme-app/rfq", definitionId: 7, source: "scan" };
    const deps = makeDeps({
      findWorkflow: (p) => (p === workflow.path ? workflow : p === otherWorkflow.path ? otherWorkflow : null),
      getBoundWorkflowPath: (id) => (id === "sess-1" ? otherWorkflow.path : null),
    });
    await start(deps);

    const res = await fetch(`${baseUrl}/api/macros/deploy/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1", workflowPath: workflow.path }),
    });

    expect(res.status).toBe(200);
    expect(deps.injectInput).toHaveBeenCalledWith(
      "sess-1",
      "cd /Users/demo/acme-app/leasing && sapiom agents deploy",
      true,
    );
  });

  it("400s a workflow-required macro when both the request and the session binding lack a workflow", async () => {
    const deps = makeDeps({ getBoundWorkflowPath: () => null });
    await start(deps);
    const res = await fetch(`${baseUrl}/api/macros/deploy/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("runs visualize with no workflow bound at all — refreshes server-side, never touches the pty", async () => {
    const deps = makeDeps(); // getBoundWorkflowPath defaults to () => null
    await start(deps);
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }), // no subject, no workflowPath, no binding
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deps.renderCanvas).toHaveBeenCalledWith("sess-1");
    expect(deps.injectInput).not.toHaveBeenCalled();
  });

  it("also runs visualize when a workflow IS bound — same server-side refresh either way", async () => {
    const deps = makeDeps({ getBoundWorkflowPath: (id) => (id === "sess-1" ? workflow.path : null) });
    await start(deps);
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }),
    });
    expect(res.status).toBe(200);
    expect(deps.renderCanvas).toHaveBeenCalledWith("sess-1");
    expect(deps.injectInput).not.toHaveBeenCalled();
  });

  it("routes an inject macro marked execution: 'background' to runBackgroundTask, never the pty", async () => {
    const backgroundMacro = {
      id: "bg-macro",
      label: "Background macro",
      icon: "Wand2",
      execution: "background" as const,
      action: { kind: "inject" as const, text: "do something in {{session.cwd}}", submit: true },
    };
    const deps = makeDeps({ listMacros: () => [...DEFAULT_MACROS, backgroundMacro] });
    await start(deps);
    const res = await fetch(`${baseUrl}/api/macros/bg-macro/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }),
    });
    expect(res.status).toBe(200);
    const [sessionId, macro, prompt, passedWorkflowPath] = (
      deps.runBackgroundTask as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, { id: string }, string, string | null];
    expect(sessionId).toBe("sess-1");
    expect(macro.id).toBe("bg-macro");
    expect(prompt).toBe("do something in /Users/demo/acme-app"); // {{session.cwd}} substituted
    // No workflowPath on the request and no bound workflow — must be null (not omitted)
    // so TaskManager can apply its per-session dedupe key (not per-workflow).
    expect(passedWorkflowPath).toBeNull();
    expect(deps.injectInput).not.toHaveBeenCalled();
  });

  it("passes the resolved workflowPath into runBackgroundTask so TaskManager can dedupe per-workflow", async () => {
    const backgroundMacro = {
      id: "bg-wf-macro",
      label: "Background workflow macro",
      icon: "Wand2",
      execution: "background" as const,
      action: { kind: "inject" as const, text: "enrich {{workflow.path}}", submit: true },
    };
    const deps = makeDeps({ listMacros: () => [...DEFAULT_MACROS, backgroundMacro] });
    await start(deps);

    const res = await fetch(`${baseUrl}/api/macros/bg-wf-macro/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1", workflowPath: workflow.path }),
    });
    expect(res.status).toBe(200);
    const [, , , passedWorkflowPath] = (deps.runBackgroundTask as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { id: string },
      string,
      string | null,
    ];
    // workflowPath must be threaded through so TaskManager can reject a
    // second session running the same macro against the same workflow.
    expect(passedWorkflowPath).toBe(workflow.path);
  });

  it("400s visualize on a harness with no headless mode (TaskNotSupportedError from the enrichment spawn)", async () => {
    const deps = makeDeps({
      renderCanvas: vi.fn().mockRejectedValue(new TaskNotSupportedError("codex", "Visualize")),
    });
    await start(deps);
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/don't support/i);
  });

  it("409s visualize when this workflow's enrichment is already running (TaskAlreadyRunningError)", async () => {
    const deps = makeDeps({
      renderCanvas: vi.fn().mockRejectedValue(new TaskAlreadyRunningError("Visualize")),
    });
    await start(deps);
    const res = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already running/i);
  });

  it("409s with a UI-visible reason when the session isn't ready yet (SessionNotReadyError) — never silently swallows the macro", async () => {
    const deps = makeDeps({
      injectInput: vi.fn().mockRejectedValue(new SessionNotReadyError("sess-1")),
    });
    await start(deps);

    const res = await fetch(`${baseUrl}/api/macros/deploy/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harnessSessionId: "sess-1", workflowPath: workflow.path }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not ready yet/i);
    expect(body.error).toMatch(/trust the folder/i);
  });
});
