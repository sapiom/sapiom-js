import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { startOpenCodeServer, type OpenCodeServer } from "./server.js";

const fixture = fileURLToPath(
  new URL("./__fixtures__/fake-opencode.mjs", import.meta.url),
);

const liveServers = new Set<OpenCodeServer>();

afterEach(async () => {
  await Promise.all([...liveServers].map((server) => server.close()));
  liveServers.clear();
});

describe("startOpenCodeServer", () => {
  it("starts an authenticated child with isolated state and closes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sapiom-opencode-test-"));
    const cwd = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(cwd);
    const canonicalCwd = await realpath(cwd);

    const server = await startOpenCodeServer({
      command: {
        executable: process.execPath,
        prefixArgs: [fixture],
      },
      cwd: canonicalCwd,
      stateRoot,
      config: { model: "sapiom/test-model" },
    });
    liveServers.add(server);

    expect(server.health).toEqual({
      healthy: true,
      version: "fake-opencode",
    });

    const unauthorized = await fetch(new URL("/global/health", server.origin));
    expect(unauthorized.status).toBe(401);

    const environment = await server.fetchJson<{
      cwd: string;
      config: string;
      xdgConfig: string;
      xdgData: string;
      xdgCache: string;
      xdgState: string;
      disableClaudeCode: string;
      disableClaudeCodeSkills: string;
      disableDefaultPlugins: string;
      disableExternalSkills: string;
      disableProjectConfig: string;
      disableAutoupdate: string;
    }>("/debug/environment");

    expect(environment).toEqual({
      cwd: canonicalCwd,
      config: JSON.stringify({ model: "sapiom/test-model" }),
      xdgConfig: join(stateRoot, "config"),
      xdgData: join(stateRoot, "data"),
      xdgCache: join(stateRoot, "cache"),
      xdgState: join(stateRoot, "state"),
      disableClaudeCode: "1",
      disableClaudeCodeSkills: "1",
      disableDefaultPlugins: "1",
      disableExternalSkills: "1",
      disableProjectConfig: "1",
      disableAutoupdate: "1",
    });

    const pid = server.pid;
    await server.close();
    await server.close();
    liveServers.delete(server);

    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reports child stderr when OpenCode exits before becoming healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "sapiom-opencode-test-"));
    const cwd = join(root, "project");
    await mkdir(cwd);

    await expect(
      startOpenCodeServer({
        command: {
          executable: process.execPath,
          prefixArgs: [fixture],
        },
        cwd,
        stateRoot: join(root, "state"),
        environment: { FAKE_OPENCODE_FAIL: "1" },
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "OpenCodeStartupError",
      message: expect.stringContaining("fake opencode failed before listening"),
    });
  });

  it("reports a missing OpenCode executable without hanging", async () => {
    const root = await mkdtemp(join(tmpdir(), "sapiom-opencode-test-"));
    const cwd = join(root, "project");
    await mkdir(cwd);

    await expect(
      startOpenCodeServer({
        command: { executable: join(root, "missing-opencode") },
        cwd,
        stateRoot: join(root, "state"),
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "OpenCodeStartupError",
      message: expect.stringContaining("ENOENT"),
    });
  });
});
