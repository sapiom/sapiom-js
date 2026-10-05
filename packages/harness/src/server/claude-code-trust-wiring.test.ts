import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string | undefined;
let server: HarnessServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("adding a project pre-trusts its root for Claude Code and nothing else (SAP-3879)", async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-trust-wiring-")),
  );
  const stateRoot = path.join(root, "profile");
  const opened = path.join(root, "opened-project");
  await fs.mkdir(stateRoot);
  await fs.mkdir(opened);
  // test-setup.ts gives every file an isolated HOME; Claude Code reads
  // ~/.claude.json there.
  const configFile = path.join(os.homedir(), ".claude.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({ theme: "dark", projects: { "/kept": { a: 1 } } }),
  );
  server = await startServer({
    port: 0,
    bootToken: "test-token",
    telemetryOptIn: false,
    adapters: {},
    availableHarnesses: ["claude-code"],
    stateRoot,
    launchDir: stateRoot,
    projectRoot: path.join(stateRoot, "projects"),
    autoCreateSession: false,
    loadSystemPrompt: async () => "",
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Harness-Token": "test-token",
    },
    body: JSON.stringify({ recentDirs: [opened] }),
  });
  expect(response.status).toBe(200);

  await vi.waitFor(
    async () => {
      const config = JSON.parse(await fs.readFile(configFile, "utf8"));
      expect(config).toEqual({
        theme: "dark",
        projects: {
          "/kept": { a: 1 },
          [opened]: { hasTrustDialogAccepted: true },
        },
      });
    },
    { timeout: 10_000 },
  );
}, 20_000);

it("a Claude Code session waits for its added project's trust record, and only an added root gets one (SAP-3879)", async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-trust-session-")),
  );
  const stateRoot = path.join(root, "profile");
  // Added before Studio pre-trusted roots: no record yet.
  const existing = path.join(root, "existing-project");
  const inside = path.join(existing, "agent");
  const elsewhere = path.join(root, "not-a-project");
  await fs.mkdir(stateRoot);
  await fs.mkdir(inside, { recursive: true });
  await fs.mkdir(elsewhere);
  await fs.writeFile(
    path.join(stateRoot, "settings.json"),
    JSON.stringify({ recentDirs: [existing] }),
  );
  const configFile = path.join(os.homedir(), ".claude.json");
  await fs.writeFile(configFile, JSON.stringify({ theme: "light" }));
  const adapter: HarnessAdapter = {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts) => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }),
    resume: (_id, opts) => ({
      command: "bash",
      args: [],
      env: {},
      cwd: opts.cwd,
    }),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
  server = await startServer({
    port: 0,
    bootToken: "test-token",
    telemetryOptIn: false,
    adapters: { "claude-code": adapter },
    stateRoot,
    launchDir: stateRoot,
    projectRoot: path.join(stateRoot, "projects"),
    autoCreateSession: false,
    loadSystemPrompt: async () => "",
  });
  // A running Claude Code is mid-save: the session waits for the lock.
  const lock = `${configFile}.lock`;
  await fs.mkdir(lock);
  setTimeout(() => void fs.rmdir(lock), 300);
  await server.sessionManager.create({ cwd: inside, harness: "claude-code" });
  const read = async () => JSON.parse(await fs.readFile(configFile, "utf8"));
  // Written before the session spawned; the project root, not the agent folder.
  expect(await read()).toEqual({
    theme: "light",
    projects: { [existing]: { hasTrustDialogAccepted: true } },
  });

  await server.sessionManager.create({
    cwd: elsewhere,
    harness: "claude-code",
  });
  expect(Object.keys((await read()).projects)).toEqual([existing]);

  // Added under a symlink spelling, the session asks for the physical path.
  const physical = path.join(root, "physical-project");
  const linked = path.join(root, "linked-project");
  await fs.mkdir(physical);
  await fs.symlink(physical, linked);
  await fs.writeFile(
    path.join(stateRoot, "settings.json"),
    JSON.stringify({ recentDirs: [existing, linked] }),
  );
  await server.sessionManager.create({ cwd: physical, harness: "claude-code" });
  expect((await read()).projects[physical]).toEqual({
    hasTrustDialogAccepted: true,
  });
}, 20_000);
