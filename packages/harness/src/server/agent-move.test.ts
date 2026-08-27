/**
 * The move endpoint, on a real filesystem (SAP-2930).
 *
 * Every route test here goes STRAIGHT AT THE ROUTE, with no planner involved.
 * That is the point of the ticket's "two guards, not one": the rail asks
 * `web/src/lib/agent-move.ts`'s `planMove` first, but in the reference prototype
 * the mover rewrote paths unconditionally, so anything arriving another way
 * clobbered silently. If these tests only ever posted plans the planner had
 * already blessed, they would prove nothing about that.
 *
 * Real directories, real `git`, in a temp tree created and removed per test.
 * Nothing under the user's own projects is touched.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import express from "express";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createAgentMoveRouter,
  isGitTracked,
  isWithinDir,
  moveTargetDirs,
  performMove,
  refuseMoveOnDisk,
  remapSessions,
  remapUnder,
  type AgentMoveResponse,
} from "./agent-move.js";

let tmp: string;

beforeEach(async () => {
  // realpath: macOS hands out `/var/folders/…`, a symlink to `/private/var/…`,
  // and `git` reports work-tree paths in resolved form — a `git mv` with an
  // unresolved absolute destination lands "outside repository".
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-move-")));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** An agent directory with a `sapiom.json` in it, plus any extra files. */
async function makeAgent(
  relative: string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(tmp, relative);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sapiom.json"), JSON.stringify({ name: path.basename(dir) }));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

const run = (args: string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });

const gitOut = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    );
  });

/** A committed repo at `tmp` — the tracked branch's precondition. */
async function initRepo(): Promise<void> {
  await run(["init", "-q"], tmp);
  await run(["-c", "user.email=t@t", "-c", "user.name=T", "add", "-A"], tmp);
  await run(
    ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "seed"],
    tmp,
  );
}

/**
 * Every directory under `tmp`, as the studio's drop-target list.
 *
 * The route will only move into a directory the rail can show, and in the app
 * that list is derived from the project roots and the registered agents. A
 * temp tree has neither, so the default here is "every folder that exists" —
 * permissive enough that the disk guards below are what each test is actually
 * proving, while the barrier itself gets its own tests with an explicit list.
 */
async function dirsUnder(root: string): Promise<string[]> {
  const out = [root];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await dirsUnder(path.join(root, entry.name))));
  }
  return out;
}

/** A live express app over the router, so the route is exercised as a route. */
async function serve(
  agents: string[],
  onMoved: (from: string, to: string) => Promise<void> = async () => {},
  targetDirs?: string[],
): Promise<{ post: (body: unknown) => Promise<{ status: number; body: any }>; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(
    createAgentMoveRouter({
      resolveAgent: (agentPath) =>
        agents.includes(agentPath) ? { name: path.basename(agentPath), path: agentPath } : null,
      listMoveTargetDirs: () => targetDirs ?? dirsUnder(tmp),
      onMoved,
    }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    post: async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("isWithinDir", () => {
  it("counts equality and refuses a mere name prefix", () => {
    expect(isWithinDir("/a/ads", "/a/ads")).toBe(true);
    expect(isWithinDir("/a/ads", "/a/ads/sub")).toBe(true);
    // The prefix trap: `ads-v2` is not inside `ads`.
    expect(isWithinDir("/a/ads", "/a/ads-v2")).toBe(false);
    expect(isWithinDir("/a/ads", "/a")).toBe(false);
  });
});

describe("moveTargetDirs", () => {
  const ROOT = path.resolve("/p");

  it("offers the root and every directory between it and an agent", () => {
    const dirs = moveTargetDirs([ROOT], [path.join(ROOT, "backend", "src", "agents", "ads")]);
    expect(new Set(dirs)).toEqual(
      new Set([
        ROOT,
        path.join(ROOT, "backend"),
        path.join(ROOT, "backend", "src"),
        path.join(ROOT, "backend", "src", "agents"),
      ]),
    );
  });

  it("does NOT offer the agent's own directory — an agent row is not a drop target", () => {
    const agent = path.join(ROOT, "agents", "ads");
    expect(moveTargetDirs([ROOT], [agent])).not.toContain(agent);
  });

  it("ignores an agent that sits outside every known root", () => {
    expect(moveTargetDirs([ROOT], [path.resolve("/elsewhere/agents/ads")])).toEqual([ROOT]);
  });

  it("files a directory under every root that contains it, and dedupes", () => {
    const nested = path.join(ROOT, "services");
    const dirs = moveTargetDirs([ROOT, nested], [path.join(nested, "workers", "queue")]);
    expect(new Set(dirs)).toEqual(new Set([ROOT, nested, path.join(nested, "workers")]));
  });

  it("survives a root that is the filesystem root without spinning", () => {
    const root = path.parse(process.cwd()).root;
    expect(moveTargetDirs([root], [path.join(root, "ads")])).toEqual([root]);
  });
});

describe("remapUnder", () => {
  it("carries a nested agent and a session cwd along with the parent", () => {
    expect(remapUnder("/a/ads", "/a/ads", "/b/ads")).toBe("/b/ads");
    expect(remapUnder("/a/ads/sub/creative", "/a/ads", "/b/ads")).toBe("/b/ads/sub/creative");
    expect(remapUnder("/a/ads-v2", "/a/ads", "/b/ads")).toBe("/a/ads-v2");
    expect(remapUnder("/elsewhere", "/a/ads", "/b/ads")).toBe("/elsewhere");
  });
});

describe("remapSessions", () => {
  it("follows the sessions that sat inside the moved tree, and only those", () => {
    // The exact composition `server/index.ts` wires into `onMoved`. A session
    // left pointing at a directory that no longer exists is the bug.
    const sessions = [
      { cwd: "/a/ads", boundWorkflowPath: "/a/ads" },
      { cwd: "/a/ads/.worktrees/wip", boundWorkflowPath: "/a/ads/sub/creative" },
      { cwd: "/a/ads-v2", boundWorkflowPath: null },
      { cwd: "/elsewhere", boundWorkflowPath: "/elsewhere" },
    ];
    expect(remapSessions(sessions, "/a/ads", "/b/ads")).toBe(2);
    expect(sessions).toEqual([
      { cwd: "/b/ads", boundWorkflowPath: "/b/ads" },
      { cwd: "/b/ads/.worktrees/wip", boundWorkflowPath: "/b/ads/sub/creative" },
      // A mere name-prefix sibling is untouched, and so is an unrelated session.
      { cwd: "/a/ads-v2", boundWorkflowPath: null },
      { cwd: "/elsewhere", boundWorkflowPath: "/elsewhere" },
    ]);
  });

  it("leaves a binding OUTSIDE the moved tree alone while following the cwd", () => {
    // A session rooted at the project but bound to the agent that moved, and one
    // rooted inside the agent but bound to a neighbour: each half is decided on
    // its own path, never on the other's.
    const sessions = [{ cwd: "/a/ads/deep", boundWorkflowPath: "/a/outreach" }];
    expect(remapSessions(sessions, "/a/ads", "/b/ads")).toBe(1);
    expect(sessions[0]).toEqual({ cwd: "/b/ads/deep", boundWorkflowPath: "/a/outreach" });
  });

  it("reports nothing changed when no session was inside", () => {
    const sessions = [{ cwd: "/elsewhere", boundWorkflowPath: null }];
    expect(remapSessions(sessions, "/a/ads", "/b/ads")).toBe(0);
  });
});

describe("refuseMoveOnDisk", () => {
  it("allows a move to an empty destination under an existing parent", async () => {
    const from = await makeAgent("backend/agents/ads");
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    expect(await refuseMoveOnDisk(from, path.join(tmp, "services", "ads"))).toBeNull();
  });

  it("refuses a destination that already exists — INCLUDING a plain directory", async () => {
    // The case a path list can never see: `services/ads` holds no agent, so the
    // planner would wave this through. Only a `stat` catches it.
    const from = await makeAgent("backend/agents/ads");
    await fs.mkdir(path.join(tmp, "services", "ads"), { recursive: true });
    const refusal = await refuseMoveOnDisk(from, path.join(tmp, "services", "ads"));
    expect(refusal).toContain("already exists");
    expect(refusal).toContain("ads");
  });

  it("refuses a destination that is a dangling symlink", async () => {
    // `rename` would happily replace it, and the user put it there.
    const from = await makeAgent("backend/agents/ads");
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    const to = path.join(tmp, "services", "ads");
    await fs.symlink(path.join(tmp, "nowhere"), to);
    expect(await refuseMoveOnDisk(from, to)).toContain("already exists");
  });

  it("refuses a move into the moved directory's own subtree", async () => {
    const from = await makeAgent("backend/agents/ads");
    expect(await refuseMoveOnDisk(from, path.join(from, "nested"))).toBe(
      "Can't move ads inside itself.",
    );
  });

  it("refuses when the destination's parent does not exist", async () => {
    const from = await makeAgent("backend/agents/ads");
    expect(await refuseMoveOnDisk(from, path.join(tmp, "nope", "ads"))).toContain("does not exist");
  });

  it("refuses a source that is gone", async () => {
    expect(await refuseMoveOnDisk(path.join(tmp, "gone"), path.join(tmp, "ads"))).toContain(
      "no longer exists",
    );
  });
});

describe("git mv vs plain rename", () => {
  it("uses `git mv` for a TRACKED directory, and git records it as a rename", async () => {
    const from = await makeAgent("backend/agents/ads", { "steps/one.ts": "export {}\n" });
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    await initRepo();
    expect(await isGitTracked(from)).toBe(true);

    const to = path.join(tmp, "services", "ads");
    expect(await performMove(from, to)).toBe("git");

    // Staged as a rename, which is the whole reason to prefer `git mv`: a plain
    // rename reaches git as a delete plus a pile of untracked files.
    const status = await gitOut(["status", "--porcelain"], tmp);
    expect(status).toMatch(/^R/m);
    expect(status).not.toMatch(/^\?\?/m);
    expect(await fs.readFile(path.join(to, "steps", "one.ts"), "utf8")).toBe("export {}\n");
  });

  it("uses a plain rename with NO repo at all", async () => {
    const from = await makeAgent("backend/agents/ads");
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    expect(await isGitTracked(from)).toBe(false);
    expect(await performMove(from, path.join(tmp, "services", "ads"))).toBe("rename");
    expect(await fs.readdir(path.join(tmp, "services", "ads"))).toContain("sapiom.json");
  });

  it("uses a plain rename for a GITIGNORED directory inside a repo", async () => {
    // Inside a work tree but untracked, and `git mv` refuses those — which is
    // why the question is "does git know about these files", not "is there a
    // repo here".
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".gitignore"), "scratch/\n");
    await initRepo();
    const from = await makeAgent("scratch/ads");
    expect(await isGitTracked(from)).toBe(false);
    expect(await performMove(from, path.join(tmp, "services", "ads"))).toBe("rename");
  });
});

describe("POST /api/agents/move", () => {
  it("moves the directory and reports how", async () => {
    const from = await makeAgent("backend/agents/ads");
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    const to = path.join(tmp, "services", "ads");
    const moved: Array<[string, string]> = [];
    const api = await serve([from], async (a, b) => {
      moved.push([a, b]);
    });
    try {
      const res = await api.post({ from, to });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, moved: true, from, to, kind: "rename" });
      // `onMoved` is how the rail learns to re-derive the tree from the new path.
      expect(moved).toEqual([[from, to]]);
      await expect(fs.stat(from)).rejects.toThrow();
      expect(await fs.readdir(to)).toContain("sapiom.json");
    } finally {
      await api.close();
    }
  });

  it("REFUSES an occupied destination when called directly, planner bypassed", async () => {
    // The criterion this whole module exists for. No `planMove` ran; the route
    // stats the destination itself and says no.
    const from = await makeAgent("services/workers/ads");
    const occupied = await makeAgent("backend/src/agents/ads");
    const api = await serve([from, occupied]);
    try {
      const res = await api.post({ from, to: occupied });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already exists");
      // And it did NOT clobber: both directories are still there, intact.
      expect(await fs.readdir(from)).toContain("sapiom.json");
      expect(await fs.readdir(occupied)).toContain("sapiom.json");
    } finally {
      await api.close();
    }
  });

  it("refuses a destination inside the moved directory", async () => {
    const from = await makeAgent("backend/agents/ads");
    const api = await serve([from]);
    try {
      const res = await api.post({ from, to: path.join(from, "steps", "ads") });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Can't move ads inside itself.");
    } finally {
      await api.close();
    }
  });

  it("answers a drop where the agent already sits as a SILENT success", async () => {
    const from = await makeAgent("backend/agents/ads");
    const moved: Array<[string, string]> = [];
    const api = await serve([from], async (a, b) => {
      moved.push([a, b]);
    });
    try {
      const res = await api.post({ from, to: from });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, moved: false, kind: null });
      // Nothing happened, so nothing is announced and nothing is rescanned.
      expect(moved).toEqual([]);
      expect(await fs.readdir(from)).toContain("sapiom.json");
    } finally {
      await api.close();
    }
  });

  it("carries a NESTED agent and a session's cwd along with the parent", async () => {
    const from = await makeAgent("backend/agents/ads", { "sub/creative/sapiom.json": "{}" });
    // A session rooted inside the moved tree — a worktree or a scratch dir.
    await fs.mkdir(path.join(from, ".worktrees", "wip"), { recursive: true });
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    const to = path.join(tmp, "services", "ads");
    const sessionCwd = path.join(from, ".worktrees", "wip");
    const api = await serve([from, path.join(from, "sub", "creative")]);
    try {
      expect((await api.post({ from, to })).status).toBe(200);
      // On disk: the nested agent went with it, because it had no choice.
      expect(await fs.stat(path.join(to, "sub", "creative", "sapiom.json"))).toBeTruthy();
      // And the rule the integrator applies to every live session's cwd.
      expect(remapUnder(sessionCwd, from, to)).toBe(path.join(to, ".worktrees", "wip"));
      expect(await fs.stat(remapUnder(sessionCwd, from, to))).toBeTruthy();
    } finally {
      await api.close();
    }
  });

  it("refuses a `from` that is not a registered agent", async () => {
    const stranger = await makeAgent("somebody/elses/dir");
    const api = await serve([]);
    try {
      const res = await api.post({ from: stranger, to: path.join(tmp, "here") });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("registered agent");
      expect(await fs.readdir(stranger)).toContain("sapiom.json");
    } finally {
      await api.close();
    }
  });

  it("REFUSES a destination the studio does not show, and touches nothing", async () => {
    // The structural barrier, not a stat: `stash` exists, is empty, and would
    // happily accept a rename — but it is not a directory the rail draws, so
    // the route will not rename user code into it.
    const from = await makeAgent("backend/agents/ads");
    const stash = path.join(tmp, "stash");
    await fs.mkdir(stash, { recursive: true });
    const moved: Array<[string, string]> = [];
    const api = await serve([from], async (a, b) => {
      moved.push([a, b]);
    }, [
      path.join(tmp, "backend", "agents"),
    ]);
    try {
      const res = await api.post({ from, to: path.join(stash, "ads") });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("doesn't show that folder");
      expect(await fs.readdir(from)).toContain("sapiom.json");
      expect(await fs.readdir(stash)).toEqual([]);
      expect(moved).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("moves into a listed directory even when the request spells it differently", async () => {
    // The request is a LOOKUP KEY: the directory that gets used is the one from
    // the server's own list, so a trailing separator (or any other spelling the
    // client happens to hold) changes nothing about where the agent lands.
    const from = await makeAgent("backend/agents/ads");
    const services = path.join(tmp, "services");
    await fs.mkdir(services, { recursive: true });
    const api = await serve([from], async () => {}, [services]);
    try {
      const res = await api.post({ from, to: path.join(`${services}${path.sep}`, "ads") });
      expect(res.status).toBe(200);
      expect(res.body.to).toBe(path.join(services, "ads"));
      expect(await fs.readdir(path.join(services, "ads"))).toContain("sapiom.json");
    } finally {
      await api.close();
    }
  });

  it("refuses a `to` that would RENAME the agent rather than move it", async () => {
    const from = await makeAgent("backend/agents/ads");
    const services = path.join(tmp, "services");
    await fs.mkdir(services, { recursive: true });
    const api = await serve([from], async () => {}, [services]);
    try {
      const res = await api.post({ from, to: path.join(services, "ads-v2") });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("rename");
      await expect(fs.stat(path.join(services, "ads-v2"))).rejects.toThrow();
      expect(await fs.readdir(from)).toContain("sapiom.json");
    } finally {
      await api.close();
    }
  });

  it("moves the agent the REGISTRY names, not the path the request spelled", async () => {
    // `from` is a lookup key too. The registry hands back the real directory,
    // and that is what moves — a request that resolves to a registered agent
    // can never redirect the `mv` at some other place on disk.
    const real = await makeAgent("backend/agents/ads");
    const services = path.join(tmp, "services");
    await fs.mkdir(services, { recursive: true });
    const decoy = path.join(tmp, "decoy");
    const app = express();
    app.use(express.json());
    app.use(
      createAgentMoveRouter({
        // Whatever is asked for, the registry answers with the real agent.
        resolveAgent: () => ({ name: "ads", path: real }),
        listMoveTargetDirs: () => [services],
        onMoved: async () => {},
      }),
    );
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: decoy, to: path.join(services, "ads") }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as AgentMoveResponse).from).toBe(real);
      expect(await fs.readdir(path.join(services, "ads"))).toContain("sapiom.json");
      await expect(fs.stat(real)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a relative or traversing path outright", async () => {
    const from = await makeAgent("backend/agents/ads");
    const api = await serve([from]);
    try {
      expect((await api.post({ from, to: "relative/ads" })).status).toBe(400);
      expect((await api.post({ from, to: `${tmp}/../escaped/ads` })).status).toBe(400);
      expect((await api.post({ from: 7, to: 9 })).status).toBe(400);
      expect(await fs.readdir(from)).toContain("sapiom.json");
    } finally {
      await api.close();
    }
  });
});

describe("the response type is honest about what happened", () => {
  it("names the kind on a tracked move", async () => {
    const from = await makeAgent("backend/agents/ads");
    await fs.mkdir(path.join(tmp, "services"), { recursive: true });
    await initRepo();
    const api = await serve([from]);
    try {
      const res = await api.post({ from, to: path.join(tmp, "services", "ads") });
      const body = res.body as AgentMoveResponse;
      expect(body.kind).toBe("git");
    } finally {
      await api.close();
    }
  });
});
