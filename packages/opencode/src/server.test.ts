import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenCodeStartupError,
  startOpenCodeServer,
  type OpenCodeServer,
} from "./server.js";
import { createSapiomOpenCodeConfig } from "./config.js";

let directory: string;
let server: OpenCodeServer | undefined;
const command = {
  executable: process.execPath,
  prefixArgs: [
    fileURLToPath(new URL("./__fixtures__/server.mjs", import.meta.url)),
  ],
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "opencode-runtime-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(directory, { recursive: true, force: true });
});
const options = (config: Record<string, unknown> = {}) => ({
  command,
  config,
  cwd: directory,
  stateRoot: join(directory, "state"),
});

describe("packaged OpenCode runtime", () => {
  it("uses the bridge for model and MCP authentication and strips host secrets from tool environments", async () => {
    const config = createSapiomOpenCodeConfig({
      bridgeUrl: "http://127.0.0.1:1234/opencode-runtime/runtime",
      runtimeToken: "scoped-token",
    });
    server = await startOpenCodeServer({
      ...options(config),
      environment: {
        ...process.env,
        SAPIOM_API_KEY: "sk_private",
        ANTHROPIC_API_KEY: "private",
        ESBUILD_BINARY_PATH: "/app.asar/private",
      },
    });
    const inspected = await server.fetchJson<{
      cwd: string;
      config: Record<string, unknown>;
      keys: string[];
    }>("/inspect");
    expect(inspected.cwd).toBe(directory);
    expect(inspected.config).toEqual(config);
    expect(JSON.stringify(inspected)).not.toContain("sk_private");
    for (const key of [
      "SAPIOM_API_KEY",
      "ANTHROPIC_API_KEY",
      "ESBUILD_BINARY_PATH",
    ])
      expect(inspected.keys).not.toContain(key);
    expect(JSON.stringify(config)).toContain("/llm/v2/openai/v1");
    expect(JSON.stringify(config)).toContain("/mcp");
    await expect(server.fetch("https://other.example/private")).rejects.toThrow(
      "Invalid",
    );
    await expect(server.fetch("//other.example/private")).rejects.toThrow(
      "Invalid",
    );
    await expect(server.fetchJson("/missing")).rejects.toThrow(
      "OpenCode request failed",
    );
    const pid = server.pid;
    await Promise.all([server.close(), server.close()]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("bounds hung startup, cleans up the child, and allows another startup", async () => {
    await expect(
      startOpenCodeServer({
        ...options({ stall: true }),
        startupTimeoutMs: 400,
      }),
    ).rejects.toMatchObject({
      name: "OpenCodeStartupError",
      code: "timed-out",
      retryable: true,
      message: "OpenCode took too long to start. Retry the connection.",
    });
    const pid = Number(await readFile(join(directory, "runtime.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    server = await startOpenCodeServer(options());
    expect(server.pid).not.toBe(pid);
  });

  it("honors revocation during startup and sanitizes child diagnostics", async () => {
    const abort = new AbortController();
    const starting = startOpenCodeServer({
      ...options({ stall: true }),
      signal: abort.signal,
    });
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await expect(starting).rejects.toMatchObject({
        code: "cancelled",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    await expect(
      startOpenCodeServer(options({ crash: true })),
    ).rejects.toMatchObject({
      code: "exited",
      exitCode: 1,
      retryable: true,
      message:
        "OpenCode exited before it became ready. Retry, then update or reinstall Studio if the problem continues.",
    });
  });

  it("classifies real executable path and permission failures without raw details", async () => {
    const missing = join(directory, "private-provider-token-missing");
    await expect(
      startOpenCodeServer({
        ...options(),
        command: { executable: missing },
      }),
    ).rejects.toEqual(new OpenCodeStartupError("executable-not-found"));
    if (process.platform !== "win32") {
      const blocked = join(directory, "private-provider-token-blocked");
      await writeFile(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      await expect(
        startOpenCodeServer({
          ...options(),
          command: { executable: blocked },
        }),
      ).rejects.toEqual(new OpenCodeStartupError("permission-denied"));
    }
    expect(
      (await readdir(join(directory, "state"))).filter((entry) =>
        entry.startsWith("launch-"),
      ),
    ).toEqual([]);
  });

  it.each([
    "https://remote.example",
    "http://remote.example",
    "http://user:password@127.0.0.1",
    "http://127.0.0.1/?secret=yes",
  ])("refuses a non-private bridge: %s", (bridgeUrl) => {
    expect(() =>
      createSapiomOpenCodeConfig({ bridgeUrl, runtimeToken: "token" }),
    ).toThrow("private loopback");
  });
});
