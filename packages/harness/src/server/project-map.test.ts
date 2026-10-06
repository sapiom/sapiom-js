import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMap,
  MapInputError,
  type MapDescription,
  type PlatformSource,
  type ScanOptions,
} from "@sapiom/mcp/map";

import { createBootTokenMiddleware } from "./auth.js";
import {
  createProjectMapRouter,
  gitRefs,
  type ProjectMapProject,
} from "./project-map.js";

const PROJECT_ID = "project_00000000-0000-4000-8000-000000000001";
const headers = { "X-Harness-Token": "test-token" };

function description(root: string): MapDescription {
  return {
    root,
    agents: [
      { slug: "planner", path: "planner", description: "Plans" },
      { slug: "writer", path: "writer", description: "Writes" },
    ],
  };
}

describe("createProjectMapRouter", () => {
  const dirs: string[] = [];
  let server: ReturnType<express.Express["listen"]> | undefined;

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-map-router-"));
    dirs.push(dir);
    return dir;
  }

  async function start(
    overrides: {
      project?: ProjectMapProject | null;
      describe?: (options: ScanOptions) => Promise<MapDescription>;
      platform?: () => PlatformSource | null;
      onRootRead?: (projectId: string, root: string) => void;
    } = {},
  ) {
    const root = await tempDir();
    const project =
      overrides.project === undefined
        ? { projectId: PROJECT_ID, displayName: "Research", roots: [root] }
        : overrides.project;
    const describeSpy = vi.fn(
      overrides.describe ?? (async (options: ScanOptions) => description(`${options.root}-real`)),
    );
    const resolveProject = vi.fn(async (projectId: string) =>
      project && projectId === project.projectId ? project : null,
    );
    const app = express();
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use(
      "/api",
      createProjectMapRouter({
        resolveProject,
        platform: overrides.platform ?? (() => null),
        onRootRead: overrides.onRootRead,
        describe: describeSpy,
      }),
    );
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      root,
      describeSpy,
      get: (query = "", id = PROJECT_ID, auth: Record<string, string> = headers) =>
        fetch(`${baseUrl}/api/projects/${id}/map${query}`, { headers: auth }),
    };
  }

  it("requires the boot token", async () => {
    const f = await start();
    expect((await f.get("", PROJECT_ID, {})).status).toBe(401);
    expect(f.describeSpy).not.toHaveBeenCalled();
  });

  it("answers with the map of the described agents rooted at the project root", async () => {
    const f = await start();
    const response = await f.get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["displayName", "git", "map", "projectId"]);
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.displayName).toBe("Research");
    expect(body.git).toBeNull();
    // The scan reported `${root}-real`; the response keeps the opened folder.
    expect(body.map).toEqual({ ...buildMap(description(`${f.root}-real`)), root: f.root });
    expect(body.map.root).toBe(f.root);
    expect(f.describeSpy).toHaveBeenCalledWith({ root: f.root, platform: null });
  });

  it("passes a valid ref through to describe", async () => {
    const f = await start();
    const response = await f.get("?ref=feature/x%7E2");

    expect(response.status).toBe(200);
    expect(f.describeSpy).toHaveBeenCalledWith({
      root: f.root,
      ref: "feature/x~2",
      platform: null,
    });
  });

  it.each(["--upload-pack=x", "a b", "-x", "a;b"])(
    "rejects the invalid ref %j before describe runs",
    async (ref) => {
      const f = await start();
      const response = await f.get(`?ref=${encodeURIComponent(ref)}`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_REF", error: "Not a git ref" });
      expect(f.describeSpy).not.toHaveBeenCalled();
    },
  );

  it("answers 404 project_not_found for an unknown project", async () => {
    const f = await start();
    const response = await f.get("", "project_00000000-0000-4000-8000-000000000099");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "project_not_found",
      error: "Studio project not found",
    });
    expect(f.describeSpy).not.toHaveBeenCalled();
  });

  it("answers 409 project_unavailable for a project with no open roots", async () => {
    const onRootRead = vi.fn();
    const f = await start({
      project: { projectId: PROJECT_ID, displayName: "Closed", roots: [] },
      onRootRead,
    });
    const response = await f.get();

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("project_unavailable");
    expect(f.describeSpy).not.toHaveBeenCalled();
    expect(onRootRead).not.toHaveBeenCalled();
  });

  it("turns a MapInputError into a 400 with its code", async () => {
    const f = await start({
      describe: async () => {
        throw new MapInputError("UNKNOWN_REF", 'No commit "nope"');
      },
    });
    const response = await f.get("?ref=nope");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "UNKNOWN_REF", error: 'No commit "nope"' });
  });

  it("answers 409 project_unavailable when the project's folder no longer exists", async () => {
    const f = await start({
      describe: async () => {
        throw new MapInputError("NOT_A_DIRECTORY", "/gone is not a directory");
      },
    });
    const response = await f.get();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "project_unavailable",
      error: "The project folder no longer exists",
    });
  });

  it("answers 500 map_failed for any other error without leaking its message", async () => {
    const f = await start({
      describe: async () => {
        throw new Error("secret /private/path");
      },
    });
    const response = await f.get();
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text).code).toBe("map_failed");
    expect(text).not.toContain("secret");
  });

  it("answers 400 DUPLICATE_SLUG when two agent folders share one name", async () => {
    const f = await start({
      describe: async (options) => ({
        ...description(options.root),
        agents: [{ slug: "twin", path: "a" }, { slug: "twin", path: "b" }],
      }),
    });
    const response = await f.get();

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("DUPLICATE_SLUG");
  });

  it("reports the drawn root to onRootRead", async () => {
    const onRootRead = vi.fn();
    const f = await start({ onRootRead });
    await f.get();

    expect(onRootRead).toHaveBeenCalledWith(PROJECT_ID, f.root);
  });

  it("shares one scan between concurrent identical requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await start({
      describe: async (options) => {
        await gate;
        return description(options.root);
      },
    });
    const first = f.get();
    const second = f.get();
    await vi.waitFor(() => expect(f.describeSpy).toHaveBeenCalled());
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(f.describeSpy).toHaveBeenCalledTimes(1);
    // Nothing outlives the scan: a later read scans again.
    await f.get();
    expect(f.describeSpy).toHaveBeenCalledTimes(2);
  });

  it("reads the platform per request, passing signed-out null through", async () => {
    const signedIn: PlatformSource = {
      deployedSlugs: async () => new Set<string>(),
      triggers: async () => [],
    };
    let current: PlatformSource | null = null;
    const platform = vi.fn(() => current);
    const f = await start({ platform });

    await f.get();
    current = signedIn;
    await f.get();

    expect(platform).toHaveBeenCalledTimes(2);
    expect(f.describeSpy.mock.calls[0]![0].platform).toBeNull();
    expect(f.describeSpy.mock.calls[1]![0].platform).toBe(signedIn);
  });
});

describe("gitRefs", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd, stdio: "pipe" },
    );

  it("returns the current branch and the sorted local branches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-map-git-"));
    dirs.push(dir);
    git(dir, "init", "--initial-branch=main");
    await fs.writeFile(path.join(dir, "file.txt"), "x");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "init");
    git(dir, "branch", "zeta");
    git(dir, "branch", "alpha");

    expect(await gitRefs(dir)).toEqual({
      branch: "main",
      branches: ["alpha", "main", "zeta"],
    });
  });

  it("returns null outside a git repository", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-map-nogit-"));
    dirs.push(dir);

    expect(await gitRefs(dir)).toBeNull();
  });
});
