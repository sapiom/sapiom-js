/**
 * THE RAIL'S PROJECT ROWS ALL HAVE A DURABLE STUDIO PROJECT.
 *
 * `WorkflowsRail` joins each rendered project row to a workspace scope by
 * `samePath(scope.cwd, project.root)` and reads the durable Studio project off
 * that scope's `projectId`. When the join fails, `mapOwnsCreation` goes false
 * and the retired direct-creation UI renders instead of the Agent Map.
 *
 * It failed on the commonest shape there is. `projectRoots`' rule 1 replaces an
 * agent's OWN directory with the folder that HOLDS it, and that folder is
 * neither a recentDir nor a session cwd — so a scope list built from those two
 * raw sources never contained it. Launch Studio inside an agent folder, which
 * is what `npx @sapiom/harness .` does in an agent repo, and the join found
 * nothing on every row.
 *
 * These specs assert the invariant rather than the symptom: for EVERY root
 * `projectRoots` returns from the state the SPA receives, that state also
 * carries a scope at that exact root whose `projectId` names a project in
 * `studioProjects`. That is the same three-step join the rail performs, so it
 * fails if the scope catalog ever stops deriving from `projectRoots` again.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AppState,
  HarnessSettings,
  WorkflowInfo,
} from "../shared/types.js";
import { samePath } from "../shared/paths.js";
import { projectRoots } from "../shared/project-roots.js";
import { startServer, type HarnessServer } from "./index.js";

async function scaffoldAgent(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "sapiom.json"),
    JSON.stringify({ name, definitionId: null }),
  );
  await fs.writeFile(path.join(dir, "index.ts"), "export {};\n");
  return dir;
}

/** The rail's own join, run over the state the SPA actually received. */
function railRows(
  state: AppState,
  settings: HarnessSettings,
): Array<{
  root: string;
  scopeCwd: string | null;
  mapOwnsCreation: boolean;
}> {
  const roots = projectRoots({
    recentDirs: settings.recentDirs,
    sessions: state.sessions.map((session) => ({
      cwd: session.cwd,
      createdAt: session.createdAt,
      status: session.status,
    })),
    pendingCwds: [],
    agentPaths: state.workflows.map((workflow) => workflow.path),
    sort: "recent",
  });
  return roots.map((root) => {
    const scope = (state.workspaceScopes ?? []).find((candidate) =>
      samePath(candidate.cwd, root),
    );
    const project = state.studioProjects?.find(
      (candidate) => candidate.projectId === scope?.projectId,
    );
    return {
      root,
      scopeCwd: scope?.cwd ?? null,
      mapOwnsCreation: project != null,
    };
  });
}

describe("every rendered project row owns a durable Studio project", () => {
  let tempRoot: string;
  let stateRoot: string;
  let workspaceRoot: string;
  let server: HarnessServer | undefined;

  const boot = async (
    launchDir: string,
    recentDirs: string[],
    expectedAgents: number,
  ) => {
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs }),
    );
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      stateRoot,
      launchDir,
      autoCreateSession: false,
    });
    const headers = { "X-Harness-Token": "test-token" };
    const base = `http://127.0.0.1:${server.port}/api`;
    // The boot scan is not awaited by `startServer`, and the derivation reads
    // the agent registry: before the first scan lands every candidate looks
    // like an ordinary folder. Read the state a user would see.
    await vi.waitFor(
      async () => {
        const response = await fetch(`${base}/workflows`, { headers });
        const workflows = (await response.json()) as WorkflowInfo[];
        expect(workflows.length).toBe(expectedAgents);
      },
      { timeout: 10_000, interval: 100 },
    );
    const [state, harnessSettings] = await Promise.all([
      fetch(`${base}/state`, { headers }).then((r) => r.json()),
      fetch(`${base}/settings`, { headers }).then((r) => r.json()),
    ]);
    return {
      state: state as AppState,
      settings: harnessSettings as HarnessSettings,
    };
  };

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-scopes-"));
    stateRoot = path.join(tempRoot, "state");
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await server?.sessionManager.flush();
    await server?.close();
    server = undefined;
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  it(
    "launching INSIDE an agent folder registers the folder that holds it",
    { timeout: 30_000 },
    async () => {
      const holding = path.join(workspaceRoot, "property-ops");
      const agentDir = await scaffoldAgent(
        path.join(holding, "tenant-screening"),
        "tenant-screening",
      );

      const { state, settings } = await boot(agentDir, [agentDir], 1);
      const rows = railRows(state, settings);

      // The row the rail draws is the HOLDING folder, one level above the
      // launch dir. That is the promotion the server used not to know about.
      expect(rows.map((row) => row.root)).toEqual([holding]);
      expect(rows[0]!.scopeCwd).toBe(holding);
      expect(rows[0]!.mapOwnsCreation).toBe(true);
      // The agent's own folder is not a project, so it gets no scope of its
      // own — a second project at that path would give a session started there
      // a different identity from the map above it.
      expect(
        (state.workspaceScopes ?? []).some((scope) =>
          samePath(scope.cwd, agentDir),
        ),
      ).toBe(false);
    },
  );

  it(
    "launching AT a folder that holds agents is unchanged",
    { timeout: 30_000 },
    async () => {
      await scaffoldAgent(path.join(workspaceRoot, "alpha"), "alpha");
      await scaffoldAgent(path.join(workspaceRoot, "beta"), "beta");

      const { state, settings } = await boot(workspaceRoot, [workspaceRoot], 2);
      const rows = railRows(state, settings);

      expect(rows.map((row) => row.root)).toEqual([workspaceRoot]);
      expect(rows.every((row) => row.mapOwnsCreation)).toBe(true);
    },
  );

  it(
    "a tree whose recentDirs already name the holding folders is unchanged",
    { timeout: 30_000 },
    async () => {
      const first = path.join(workspaceRoot, "property-ops");
      const second = path.join(workspaceRoot, "team-bots");
      await scaffoldAgent(path.join(first, "tenant-screening"), "tenant");
      await scaffoldAgent(path.join(second, "backlog-nudge"), "backlog");

      const { state, settings } = await boot(first, [first, second], 1);
      const rows = railRows(state, settings);

      expect(rows.map((row) => row.root).sort()).toEqual([first, second].sort());
      expect(rows.every((row) => row.mapOwnsCreation)).toBe(true);
    },
  );
});
