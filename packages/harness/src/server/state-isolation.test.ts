/**
 * Proves `stateRoot` actually isolates every piece of persistent state a
 * server boot (plus the settings REST surface) touches — machine-id,
 * workflows.json, settings.json — and that with no stateRoot the same files
 * land under the real home-dir default, unchanged. The home dir is mocked so
 * neither case can touch the developer's real ~/.sapiom/harness.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => fakeHome };
});

import { startServer, type HarnessServer } from "./index.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("state-root isolation", () => {
  let dir: string;
  let launchDir: string;
  let server: HarnessServer | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-state-isolation-"));
    fakeHome = path.join(dir, "home");
    launchDir = path.join(dir, "project");
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.mkdir(launchDir, { recursive: true });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roots machine-id, workflows.json and settings.json under stateRoot and leaves the home dir untouched", async () => {
    const stateRoot = path.join(dir, "state");
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      stateRoot,
      launchDir,
      autoCreateSession: false,
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = { "Content-Type": "application/json", "X-Harness-Token": "test-token" };

    // machine-id was created at boot (no machineId option passed), under stateRoot.
    const machineId = (await fs.readFile(path.join(stateRoot, "machine-id"), "utf-8")).trim();
    expect(machineId).toMatch(/^[0-9a-f-]{36}$/);

    // The boot-time launch-dir scan persisted the registry under stateRoot.
    // The scan is fire-and-forget — poll rather than racing it.
    await vi.waitFor(async () => {
      expect(await exists(path.join(stateRoot, "workflows.json"))).toBe(true);
    });

    // The settings REST surface reads and writes under stateRoot too.
    const patchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ telemetryOptIn: true }),
    });
    expect(patchRes.status).toBe(200);
    const stored = JSON.parse(await fs.readFile(path.join(stateRoot, "settings.json"), "utf-8")) as {
      telemetryOptIn: boolean;
    };
    expect(stored.telemetryOptIn).toBe(true);

    // Nothing anywhere in the (fake) home dir.
    expect(await fs.readdir(fakeHome)).toEqual([]);
  });

  it("defaults every path under ~/.sapiom/harness when no stateRoot is given", async () => {
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      launchDir,
      autoCreateSession: false,
    });

    const harnessHome = path.join(fakeHome, ".sapiom", "harness");
    expect(await exists(path.join(harnessHome, "machine-id"))).toBe(true);
    // The boot-time launch-dir scan (which persists the registry) is
    // fire-and-forget — poll rather than racing it.
    await vi.waitFor(async () => {
      expect(await exists(path.join(harnessHome, "workflows.json"))).toBe(true);
    });
  });

  it("prunes a registry entry whose path no longer exists, at boot, and persists it", async () => {
    const stateRoot = path.join(dir, "state");
    const deadPath = path.join(dir, "deleted-project");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(
      path.join(stateRoot, "workflows.json"),
      JSON.stringify([
        { name: "deleted-project", path: deadPath, definitionId: 1, source: "scan" },
        { name: "project", path: launchDir, definitionId: null, source: "connect" },
      ]),
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

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Harness-Token": "test-token" };
    const workflows = (await (await fetch(`${baseUrl}/api/workflows`, { headers })).json()) as Array<{
      path: string;
    }>;
    expect(workflows.some((w) => w.path === deadPath)).toBe(false);
    expect(workflows.some((w) => w.path === launchDir)).toBe(true);

    // The boot-time launch-dir scan re-persists the registry concurrently
    // with this read (fs.writeFile isn't atomic) — poll until a complete,
    // parseable write is on disk.
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await fs.readFile(path.join(stateRoot, "workflows.json"), "utf-8")) as Array<{
        path: string;
      }>;
      expect(persisted.some((w) => w.path === deadPath)).toBe(false);
    });
  });
});
