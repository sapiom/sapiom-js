import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createCanvasRenderRouter, type CanvasRenderRouterDeps } from "./canvas-render.js";
import { createBootTokenMiddleware } from "./auth.js";
import { CANVAS_DIR } from "../shared/types.js";

const BOOT_TOKEN = "test-boot-token";
const TOKEN_HEADER = { "X-Harness-Token": BOOT_TOKEN };

let projectDir: string;
let server: Server;
let baseUrl: string;

async function start(deps: CanvasRenderRouterDeps): Promise<void> {
  const app = express();
  // Mirrors the real wiring in server/index.ts: the boot-token middleware
  // gates every /api path, mounted ahead of the router itself.
  app.use("/api", createBootTokenMiddleware(BOOT_TOKEN));
  app.use("/api", createCanvasRenderRouter(deps));
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

describe("canvas render router", () => {
  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-canvas-render-"));
  });

  afterEach(async () => {
    await stop();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("401s without the boot token", async () => {
    await start({ getSession: () => ({ cwd: projectDir, boundWorkflowPath: null }), listWorkflows: () => [] });
    const res = await fetch(`${baseUrl}/api/canvas/sess-1/render`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("401s with the wrong boot token", async () => {
    await start({ getSession: () => ({ cwd: projectDir, boundWorkflowPath: null }), listWorkflows: () => [] });
    const res = await fetch(`${baseUrl}/api/canvas/sess-1/render`, {
      method: "POST",
      headers: { "X-Harness-Token": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("404s for an unknown session", async () => {
    await start({ getSession: () => undefined, listWorkflows: () => [] });
    const res = await fetch(`${baseUrl}/api/canvas/no-such-session/render`, {
      method: "POST",
      headers: TOKEN_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("reports ok:true with mode 'empty' — and writes nothing — for an unbound session", async () => {
    await start({ getSession: () => ({ cwd: projectDir, boundWorkflowPath: null }), listWorkflows: () => [] });
    const res = await fetch(`${baseUrl}/api/canvas/sess-1/render`, { method: "POST", headers: TOKEN_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(body).toMatchObject({ ok: true, mode: "empty" });

    // Zero extraction, zero writes: the canvas router serves the unbound
    // empty state on its own.
    await expect(fs.access(path.join(projectDir, CANVAS_DIR))).rejects.toThrow();
  });

  it("passes the session's real binding and the live workflow list through to the render", async () => {
    const listWorkflows = vi.fn().mockReturnValue([]);
    const getSession = vi.fn().mockReturnValue({ cwd: projectDir, boundWorkflowPath: "/some/workflow" });
    await start({ getSession, listWorkflows });

    await fetch(`${baseUrl}/api/canvas/sess-42/render`, { method: "POST", headers: TOKEN_HEADER });

    expect(getSession).toHaveBeenCalledWith("sess-42");
    expect(listWorkflows).toHaveBeenCalled();
  });
});
