import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startOpenCodeServer, type OpenCodeServer } from "./server.js";
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
      keys: string[];
      runtimeKeys: string[];
      credentialValueInherited: boolean;
      configChecks: {
        model: string;
        modelBridge: boolean;
        mcpBridge: boolean;
      };
    }>("/inspect");
    expect(inspected.cwd).toBe(directory);
    expect(inspected.keys).toContain("OPENCODE_EXPERIMENTAL_CODE_MODE");
    expect(inspected.keys).not.toContain("OPENCODE_EXPERIMENTAL");
    for (const key of [
      "SAPIOM_API_KEY",
      "ANTHROPIC_API_KEY",
      "ESBUILD_BINARY_PATH",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_SERVER_USERNAME",
      "OPENCODE_SERVER_PASSWORD",
    ])
      expect([...inspected.keys, ...inspected.runtimeKeys]).not.toContain(key);
    expect(inspected.credentialValueInherited).toBe(false);
    expect(inspected.configChecks).toEqual({
      model: "sapiom/smart",
      modelBridge: true,
      mcpBridge: true,
    });
    expect(config.agent).toMatchObject({
      "sapiom-final-response": { hidden: true, permission: { "*": "deny" } },
      "sapiom-turn-recovery": { hidden: true, mode: "primary" },
    });
    expect(
      (config.agent as Record<string, unknown>)["sapiom-turn-recovery"],
    ).not.toHaveProperty("permission");
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
    ).rejects.toThrow("could not start");
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
      await expect(starting).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    await expect(startOpenCodeServer(options({ crash: true }))).rejects.toThrow(
      "OpenCode could not start. Please retry.",
    );
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
