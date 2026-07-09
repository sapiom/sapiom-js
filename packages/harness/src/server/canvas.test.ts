import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { renderFileFor } from "../core/canvas-render.js";
import { assembleCanvasBody, buildErrorPanelHtml } from "../core/canvas-body.js";
import { renderCanvasDocument, TEMPLATE_HTML } from "../core/canvas-template.js";
import { createCanvasRouter, type CanvasSession } from "./canvas.js";

/** A stale legacy overview of the exact shape a pre-split server wrote to
 *  index.html: stacked "render failed" panels + the deterministic footer note. */
const LEGACY_OVERVIEW_HTML = renderCanvasDocument(
  assembleCanvasBody({
    panels: [buildErrorPanelHtml("text-to-image", "No agent was exported")],
    legend: "",
    note: "Static preview — regenerate after a workflow changes (1 workflow failed to build).",
  }),
);

async function writeIndex(dir: string, html: string): Promise<void> {
  await fs.mkdir(path.join(dir, ".sapiom", "canvas"), { recursive: true });
  await fs.writeFile(path.join(dir, ".sapiom", "canvas", "index.html"), html);
}

let projectDir: string;
let server: Server;
let baseUrl: string;
let port: number;
const sessions = new Map<string, CanvasSession>();

async function start(): Promise<void> {
  const app = express();
  app.use(createCanvasRouter((id) => sessions.get(id)));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

async function stop(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * `fetch()` normalizes percent-encoded dot segments (e.g. `%2e%2e`) client-side
 * before the request is ever sent — it never reaches the server as-is. To
 * actually exercise the server's own traversal guard, send the raw request
 * line ourselves.
 */
function rawGet(rawPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("canvas router", () => {
  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-canvas-"));
    sessions.clear();
    sessions.set("sess-1", { cwd: projectDir });
    await start();
  });

  afterEach(async () => {
    await stop();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("404s when no canvas has been written yet", async () => {
    const res = await fetch(`${baseUrl}/canvas/sess-1/`, { method: "HEAD" });
    expect(res.status).toBe(404);
  });

  it("serves the bound workflow's render file at the canvas root — resolved at request time, no index.html rewrite", async () => {
    const workflowPath = "/registered/workflows/order-triage";
    sessions.set("sess-1", { cwd: projectDir, boundWorkflowPath: workflowPath });
    const renderPath = renderFileFor(projectDir, workflowPath);
    await fs.mkdir(path.dirname(renderPath), { recursive: true });
    await fs.writeFile(renderPath, "<html><body>diagram</body></html>");
    // A stale index.html must NOT shadow the bound render.
    await fs.writeFile(path.join(projectDir, ".sapiom", "canvas", "index.html"), "<html><body>legacy</body></html>");

    const res = await fetch(`${baseUrl}/canvas/sess-1/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("diagram");
  });

  it("switching the binding changes what the same URL serves — per-request resolution", async () => {
    const flowA = "/registered/workflows/flow-a";
    const flowB = "/registered/workflows/flow-b";
    for (const [flow, body] of [
      [flowA, "diagram A"],
      [flowB, "diagram B"],
    ] as const) {
      const renderPath = renderFileFor(projectDir, flow);
      await fs.mkdir(path.dirname(renderPath), { recursive: true });
      await fs.writeFile(renderPath, `<html><body>${body}</body></html>`);
    }

    sessions.set("sess-1", { cwd: projectDir, boundWorkflowPath: flowA });
    expect(await (await fetch(`${baseUrl}/canvas/sess-1/`)).text()).toContain("diagram A");
    sessions.set("sess-1", { cwd: projectDir, boundWorkflowPath: flowB });
    expect(await (await fetch(`${baseUrl}/canvas/sess-1/`)).text()).toContain("diagram B");
  });

  it("serves a 200 'rendering…' page for a bound session whose render file doesn't exist yet", async () => {
    sessions.set("sess-1", { cwd: projectDir, boundWorkflowPath: "/registered/workflows/not-rendered-yet" });
    const res = await fetch(`${baseUrl}/canvas/sess-1/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Rendering workflow diagram");
  });

  it("an unbound session serves a genuine agent-authored custom canvas at the root", async () => {
    await writeIndex(projectDir, "<html><body>custom</body></html>");
    const res = await fetch(`${baseUrl}/canvas/sess-1/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("custom");
  });

  it("an unbound session with a STALE legacy overview index.html serves the empty state, not the overview", async () => {
    await writeIndex(projectDir, LEGACY_OVERVIEW_HTML);

    // The HEAD probe must read as "no content" (non-ok) so the CanvasPane
    // shows its own empty state rather than framing the stale overview.
    const head = await fetch(`${baseUrl}/canvas/sess-1/`, { method: "HEAD" });
    expect(head.ok).toBe(false);
    expect(head.status).toBe(404);

    const res = await fetch(`${baseUrl}/canvas/sess-1/`);
    const body = await res.text();
    expect(body).not.toContain("render failed");
    expect(body).not.toContain("Static preview");
    expect(body).toContain("Nothing rendered yet");
  });

  it("an unbound session with the seeded template index.html serves the empty state (not the template)", async () => {
    await writeIndex(projectDir, TEMPLATE_HTML);
    const res = await fetch(`${baseUrl}/canvas/sess-1/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Nothing rendered yet");
  });

  it("a BOUND session serves its render even when a stale legacy overview index.html exists", async () => {
    const workflowPath = "/registered/workflows/logo-flow";
    sessions.set("sess-1", { cwd: projectDir, boundWorkflowPath: workflowPath });
    const renderPath = renderFileFor(projectDir, workflowPath);
    await fs.mkdir(path.dirname(renderPath), { recursive: true });
    await fs.writeFile(renderPath, "<html><body>real graph</body></html>");
    await writeIndex(projectDir, LEGACY_OVERVIEW_HTML);

    const res = await fetch(`${baseUrl}/canvas/sess-1/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("real graph");
    expect(body).not.toContain("render failed");
  });

  it("serves index.html at the session's canvas root", async () => {
    await fs.mkdir(path.join(projectDir, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".sapiom", "canvas", "index.html"),
      "<html><body>hi</body></html>",
    );

    const head = await fetch(`${baseUrl}/canvas/sess-1/`, { method: "HEAD" });
    expect(head.status).toBe(200);

    const get = await fetch(`${baseUrl}/canvas/sess-1/`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/html");
    expect(await get.text()).toBe("<html><body>hi</body></html>");
  });

  it("serves nested assets under the canvas dir", async () => {
    await fs.mkdir(path.join(projectDir, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(projectDir, ".sapiom", "canvas", "index.html"), "<html></html>");
    await fs.writeFile(path.join(projectDir, ".sapiom", "canvas", "chart.js"), "console.log(1);");

    const res = await fetch(`${baseUrl}/canvas/sess-1/chart.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe("console.log(1);");
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${baseUrl}/canvas/no-such-session/`);
    expect(res.status).toBe(404);
  });

  it("blocks a literal '..' traversal attempt with 400, not by escaping the canvas root", async () => {
    await fs.mkdir(path.join(projectDir, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "secret.txt"), "nope");

    const res = await rawGet("/canvas/sess-1/../../secret.txt");
    expect(res.status).toBe(400);
  });

  it("rejects a percent-encoded traversal attempt with 400, not by escaping the canvas root", async () => {
    await fs.mkdir(path.join(projectDir, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "secret.txt"), "nope");

    const res = await rawGet("/canvas/sess-1/%2e%2e/%2e%2e/secret.txt");
    expect(res.status).toBe(400);
  });
});
