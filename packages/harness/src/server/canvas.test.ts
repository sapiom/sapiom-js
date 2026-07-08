import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createCanvasRouter, type CanvasSession } from "./canvas.js";

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
