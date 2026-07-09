import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createFsRouter, type FsListResponse } from "./fs.js";

let server: Server;
let baseUrl: string;

async function start(): Promise<void> {
  const app = express();
  app.use(createFsRouter());
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

function list(queryString: string): Promise<Response> {
  return fetch(`${baseUrl}/api/fs/list${queryString}`);
}

describe("createFsRouter", () => {
  let root: string;

  beforeAll(async () => {
    await start();
  });

  afterAll(async () => {
    await stop();
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-fs-router-"));
    await fs.mkdir(path.join(root, "zebra"));
    await fs.mkdir(path.join(root, "alpha"));
    await fs.mkdir(path.join(root, ".hidden-dir"));
    await fs.writeFile(path.join(root, "not-a-dir.txt"), "just a file");
    await fs.symlink(path.join(root, "alpha"), path.join(root, "linked-alpha"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists directories only, sorted, excluding files and symlinks", async () => {
    const res = await list(`?path=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FsListResponse;

    expect(body.path).toBe(root);
    expect(body.parent).toBe(path.dirname(root));
    expect(body.dirs.map((d) => d.name)).toEqual(["alpha", "zebra"]);
    expect(body.dirs.find((d) => d.name === "alpha")).toEqual({
      name: "alpha",
      path: path.join(root, "alpha"),
    });
  });

  it("does not follow a symlink pointing at a directory", async () => {
    const res = await list(`?path=${encodeURIComponent(root)}`);
    const body = (await res.json()) as FsListResponse;
    expect(body.dirs.map((d) => d.name)).not.toContain("linked-alpha");
  });

  it("excludes hidden (dot) directories by default", async () => {
    const res = await list(`?path=${encodeURIComponent(root)}`);
    const body = (await res.json()) as FsListResponse;
    expect(body.dirs.map((d) => d.name)).not.toContain(".hidden-dir");
  });

  it("includes hidden directories when hidden=1", async () => {
    const res = await list(`?path=${encodeURIComponent(root)}&hidden=1`);
    const body = (await res.json()) as FsListResponse;
    expect(body.dirs.map((d) => d.name)).toContain(".hidden-dir");
  });

  it("expands a leading ~ to the home directory", async () => {
    const res = await list(`?path=${encodeURIComponent("~")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FsListResponse;
    expect(body.path).toBe(os.homedir());
  });

  it("expands ~/subpath", async () => {
    const homeSubdir = path.join(os.homedir(), ".harness-fs-router-test-fixture");
    await fs.mkdir(homeSubdir, { recursive: true });
    await fs.mkdir(path.join(homeSubdir, "child"));
    try {
      const res = await list(`?path=${encodeURIComponent("~/.harness-fs-router-test-fixture")}`);
      const body = (await res.json()) as FsListResponse;
      expect(body.path).toBe(homeSubdir);
      expect(body.dirs.map((d) => d.name)).toEqual(["child"]);
    } finally {
      await fs.rm(homeSubdir, { recursive: true, force: true });
    }
  });

  it("normalizes .. segments (traversal) to the resolved absolute path", async () => {
    const nested = path.join(root, "alpha");
    const traversalPath = path.join(nested, "..", "zebra", "..", "alpha");
    const res = await list(`?path=${encodeURIComponent(traversalPath)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FsListResponse;
    expect(body.path).toBe(nested);
  });

  it("rejects a relative path with 400", async () => {
    const res = await list(`?path=${encodeURIComponent("relative/path")}`);
    expect(res.status).toBe(400);
  });

  it("rejects a missing path query param with 400", async () => {
    const res = await list("");
    expect(res.status).toBe(400);
  });

  it("returns 404 for a directory that doesn't exist", async () => {
    const res = await list(`?path=${encodeURIComponent(path.join(root, "does-not-exist"))}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 when path points at a file, not a directory", async () => {
    const res = await list(`?path=${encodeURIComponent(path.join(root, "not-a-dir.txt"))}`);
    expect(res.status).toBe(400);
  });

  it("caps results at 200 entries", async () => {
    const bigDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-fs-router-big-"));
    try {
      await Promise.all(
        Array.from({ length: 250 }, (_, i) => fs.mkdir(path.join(bigDir, `dir-${String(i).padStart(4, "0")}`))),
      );
      const res = await list(`?path=${encodeURIComponent(bigDir)}`);
      const body = (await res.json()) as FsListResponse;
      expect(body.dirs).toHaveLength(200);
    } finally {
      await fs.rm(bigDir, { recursive: true, force: true });
    }
  });
});
