import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createFsRouter, revealCommand, type FsListResponse, type RevealCommand } from "./fs.js";

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
      hasAgentProject: false,
    });
  });

  describe("hasAgentProject", () => {
    it("flags only the directories that directly contain the marker", async () => {
      await fs.writeFile(path.join(root, "alpha", "sapiom.json"), '{"name":"alpha"}');

      const res = await list(`?path=${encodeURIComponent(root)}`);
      const body = (await res.json()) as FsListResponse;

      expect(body.dirs.find((d) => d.name === "alpha")?.hasAgentProject).toBe(true);
      expect(body.dirs.find((d) => d.name === "zebra")?.hasAgentProject).toBe(false);
    });

    it("is one level deep — a container of projects is not itself a project", async () => {
      await fs.mkdir(path.join(root, "zebra", "inner"));
      await fs.writeFile(path.join(root, "zebra", "inner", "sapiom.json"), "{}");

      const res = await list(`?path=${encodeURIComponent(root)}`);
      const body = (await res.json()) as FsListResponse;

      // `zebra` holds a project but is not one. Callers that need "anything
      // under here?" use the rail's recursive scan, not this endpoint.
      expect(body.dirs.find((d) => d.name === "zebra")?.hasAgentProject).toBe(false);
    });

    it("does not mistake a DIRECTORY named sapiom.json for a project", async () => {
      await fs.mkdir(path.join(root, "alpha", "sapiom.json"));

      const res = await list(`?path=${encodeURIComponent(root)}`);
      const body = (await res.json()) as FsListResponse;

      expect(body.dirs.find((d) => d.name === "alpha")?.hasAgentProject).toBe(false);
    });

    it("rejects malformed and non-object marker contents", async () => {
      await fs.writeFile(path.join(root, "alpha", "sapiom.json"), "not-json");
      await fs.writeFile(path.join(root, "zebra", "sapiom.json"), "[]");

      const res = await list(`?path=${encodeURIComponent(root)}`);
      const body = (await res.json()) as FsListResponse;

      expect(body.dirs.find((d) => d.name === "alpha")?.hasAgentProject).toBe(false);
      expect(body.dirs.find((d) => d.name === "zebra")?.hasAgentProject).toBe(false);
    });

    it("does not badge a project inside a scanner-ignored child", async () => {
      const dist = path.join(root, "dist");
      await fs.mkdir(dist);
      await fs.writeFile(path.join(dist, "sapiom.json"), "{}");

      const res = await list(`?path=${encodeURIComponent(root)}`);
      const body = (await res.json()) as FsListResponse;

      expect(body.dirs.find((d) => d.name === "dist")?.hasAgentProject).toBe(false);
    });

    it("reports false for an unreadable child rather than failing the listing", async () => {
      const walled = path.join(root, "walled");
      await fs.mkdir(walled);
      await fs.chmod(walled, 0o000);
      try {
        const res = await list(`?path=${encodeURIComponent(root)}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as FsListResponse;
        expect(body.dirs.map((d) => d.name)).toContain("walled");
        expect(body.dirs.find((d) => d.name === "walled")?.hasAgentProject).toBe(false);
      } finally {
        // Restore so afterEach's rm can clean up.
        await fs.chmod(walled, 0o700);
      }
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

describe("POST /api/fs/reveal", () => {
  let revealServer: Server;
  let revealUrl: string;
  let root: string;
  let agentDir: string;
  let deletedAgentDir: string;
  let fileAgentPath: string;
  let outsideDir: string;
  const revealed: RevealCommand[] = [];

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "harness-fs-reveal-")));
    agentDir = path.join(root, "my agent");
    deletedAgentDir = path.join(root, "gone");
    outsideDir = path.join(root, "not-an-agent");
    fileAgentPath = path.join(root, "now-a-file");
    await fs.writeFile(fileAgentPath, "replaced");
    await fs.mkdir(agentDir);
    await fs.mkdir(outsideDir);
    const registered = new Set([agentDir, deletedAgentDir, fileAgentPath]);
    const app = express();
    app.use(
      createFsRouter({
        findAgentPath: async (p) => (registered.has(p) ? p : null),
        reveal: (cmd) => void revealed.push(cmd),
        platform: "darwin",
      }),
    );
    await new Promise<void>((resolve) => {
      revealServer = app.listen(0, "127.0.0.1", resolve);
    });
    const address = revealServer.address();
    revealUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/fs/reveal`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => revealServer.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    revealed.length = 0;
  });

  function post(body: unknown): Promise<Response> {
    return fetch(revealUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("reveals a registered agent folder: 204 and the platform command", async () => {
    const res = await post({ path: agentDir });
    expect(res.status).toBe(204);
    expect(revealed).toEqual([{ command: "open", args: ["-R", agentDir] }]);
  });

  it("normalizes the path before the registry check", async () => {
    const res = await post({ path: path.join(agentDir, "..", "my agent") });
    expect(res.status).toBe(204);
    expect(revealed).toEqual([{ command: "open", args: ["-R", agentDir] }]);
  });

  it("refuses an existing folder outside the registry with 403 and spawns nothing", async () => {
    const res = await post({ path: outsideDir });
    expect(res.status).toBe(403);
    expect(revealed).toEqual([]);
  });

  it("refuses a file inside a registered agent: only the agent folder itself", async () => {
    const res = await post({ path: path.join(agentDir, "index.ts") });
    expect(res.status).toBe(403);
    expect(revealed).toEqual([]);
  });

  it("answers 403, not 404, for an unregistered path that does not exist", async () => {
    const res = await post({ path: path.join(root, "nothing-here") });
    expect(res.status).toBe(403);
    expect(revealed).toEqual([]);
  });

  it("returns 404 for a registered agent whose folder no longer exists", async () => {
    const res = await post({ path: deletedAgentDir });
    expect(res.status).toBe(404);
    expect(revealed).toEqual([]);
  });

  it("returns 404 for a registered agent whose folder was replaced by a file", async () => {
    const res = await post({ path: fileAgentPath });
    expect(res.status).toBe(404);
    expect(revealed).toEqual([]);
  });

  it("passes a failing registry lookup to Express as a 500", async () => {
    const app = express();
    app.use(
      createFsRouter({
        findAgentPath: async () => {
          throw new Error("registry unavailable");
        },
        reveal: (cmd) => void revealed.push(cmd),
      }),
    );
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).end();
    });
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    try {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/api/fs/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: agentDir }),
      });
      expect(res.status).toBe(500);
      expect(revealed).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("answers 500 when the file manager cannot be started", async () => {
    const app = express();
    app.use(
      createFsRouter({
        findAgentPath: () => agentDir,
        reveal: () => Promise.reject(new Error("spawn xdg-open ENOENT")),
      }),
    );
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    try {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/api/fs/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: agentDir }),
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain("ENOENT");
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("rejects a missing or relative path with 400", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ path: "my agent" })).status).toBe(400);
    expect((await post({ path: 42 })).status).toBe(400);
    expect(revealed).toEqual([]);
  });

  it("refuses everything when no registry lookup was provided", async () => {
    const app = express();
    app.use(createFsRouter({ reveal: (cmd) => void revealed.push(cmd) }));
    const bare = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const address = bare.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/api/fs/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: agentDir }),
      });
      expect(res.status).toBe(403);
      expect(revealed).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});

describe("POST /api/fs/reveal rate limit", () => {
  it("answers 429 after 30 reveals in a minute", async () => {
    const app = express();
    const revealed: RevealCommand[] = [];
    app.use(createFsRouter({ findAgentPath: () => os.tmpdir(), reveal: (cmd) => void revealed.push(cmd) }));
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    try {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/fs/reveal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: os.tmpdir() }),
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 204)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect(revealed).toHaveLength(30);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe("revealCommand", () => {
  it("selects the folder in Finder on macOS", () => {
    expect(revealCommand("/a/b c", "darwin")).toEqual({ command: "open", args: ["-R", "/a/b c"] });
  });

  it("selects the folder in Explorer on Windows, path quoted after the comma", () => {
    expect(revealCommand("C:\\a\\b c", "win32")).toEqual({
      command: "explorer.exe",
      args: ['/select,"C:\\a\\b c"'],
      windowsVerbatimArguments: true,
    });
  });

  it("opens the folder with xdg-open elsewhere", () => {
    expect(revealCommand("/a/b", "linux")).toEqual({ command: "xdg-open", args: ["/a/b"] });
  });
});
