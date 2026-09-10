import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSapiomOpenCodeConfig } from "./config.js";
import { startOpenCodeServer, type OpenCodeServer } from "./server.js";

let root: string;
let runtime: OpenCodeServer | undefined;
let bridge: Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-native-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.close();
  runtime = undefined;
  await new Promise<void>(
    (resolve) => bridge?.close(() => resolve()) ?? resolve(),
  );
  bridge = undefined;
  await rm(root, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? (JSON.parse(body) as unknown) : undefined;
}

async function startSyntheticBridge(token: string) {
  const state = {
    valid: true,
    modelAuthorized: 0,
    mcpAuthorized: 0,
    rejected: 0,
    requests: [] as string[],
  };
  bridge = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    state.requests.push(`${request.method} ${url.pathname}`);
    const authorized = request.headers.authorization === `Bearer ${token}`;
    if (!authorized || !state.valid) {
      state.rejected++;
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Authentication is required.",
            type: "authentication_error",
            code: "authentication_required",
          },
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/mcp")) {
      state.mcpAuthorized++;
      if (request.method === "GET") {
        response.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      const message = (await readRequestBody(request)) as {
        id?: string | number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: [] }
            : {};
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      return;
    }
    if (url.pathname.endsWith("/chat/completions")) {
      state.modelAuthorized++;
      await readRequestBody(request);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl_synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "smart",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "synthetic native reply" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl_synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "smart",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => bridge!.listen(0, "127.0.0.1", resolve));
  const address = bridge.address();
  if (!address || typeof address === "string") throw new Error("bridge failed");
  return { origin: `http://127.0.0.1:${address.port}`, state };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("pinned OpenCode 1.18.29", () => {
  it("scrubs credential names and values from a real shell while retaining native admin auth", async () => {
    const projectMarker = join(root, "project-plugin-ran");
    const globalMarker = join(root, "global-plugin-ran");
    const homeDotMarker = join(root, "home-dot-opencode-plugin-ran");
    const configuredMarker = join(root, "configured-plugin-ran");
    const hostileHome = join(root, "hostile-home");
    const hostileXdg = join(root, "hostile-xdg");
    const projectPlugin = join(root, ".opencode", "plugin", "hostile.mjs");
    const globalPlugin = join(root, "hostile-global.mjs");
    const homeDotPlugin = join(root, "hostile-home-dot-opencode.mjs");
    const configuredPlugin = join(root, "hostile-configured.mjs");
    const pluginSource = (marker: string) =>
      `import { writeFile } from "node:fs/promises";\n` +
      `export const Hostile = async () => { await writeFile(${JSON.stringify(marker)}, "ran"); return {}; };\n`;
    await Promise.all([
      mkdir(join(root, ".opencode", "plugin"), { recursive: true }),
      mkdir(join(hostileHome, ".config", "opencode"), { recursive: true }),
      mkdir(join(hostileHome, ".opencode"), { recursive: true }),
      mkdir(join(hostileXdg, "opencode"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(projectPlugin, pluginSource(projectMarker)),
      writeFile(globalPlugin, pluginSource(globalMarker)),
      writeFile(homeDotPlugin, pluginSource(homeDotMarker)),
      writeFile(configuredPlugin, pluginSource(configuredMarker)),
    ]);
    const hostileConfig = JSON.stringify({
      plugin: [pathToFileURL(globalPlugin).href],
    });
    await Promise.all([
      writeFile(
        join(root, ".opencode", "opencode.json"),
        JSON.stringify({ plugin: [pathToFileURL(projectPlugin).href] }),
      ),
      writeFile(
        join(hostileHome, ".config", "opencode", "opencode.json"),
        hostileConfig,
      ),
      writeFile(
        join(hostileHome, ".opencode", "opencode.json"),
        JSON.stringify({ plugin: [pathToFileURL(homeDotPlugin).href] }),
      ),
      writeFile(join(hostileXdg, "opencode", "opencode.json"), hostileConfig),
    ]);

    const runtimeToken = "synthetic-runtime-token";
    const config = {
      ...createSapiomOpenCodeConfig({
        bridgeUrl: "http://127.0.0.1:9/runtime",
        runtimeToken,
      }),
      plugin: [pathToFileURL(configuredPlugin).href],
    };
    const realFetch = globalThis.fetch;
    let nativeOrigin = "";
    let nativeAuthorization = "";
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const authorization = new Headers(init?.headers).get("Authorization");
      if (
        url.pathname === "/global/health" &&
        authorization?.startsWith("Basic ")
      ) {
        nativeOrigin = url.origin;
        nativeAuthorization = authorization;
      }
      return realFetch(input, init);
    });
    runtime = await startOpenCodeServer({
      cwd: root,
      stateRoot: join(root, "state"),
      config,
      environment: {
        ...process.env,
        HOME: hostileHome,
        XDG_CONFIG_HOME: hostileXdg,
        COLORTERM: "sapiom-native-environment-probe",
        SAPIOM_API_KEY: "synthetic-host-key",
        ANTHROPIC_API_KEY: "synthetic-provider-key",
      },
    });

    const session = await runtime.fetchJson<{ id: string }>("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const inspect = [
      "const { createHash } = require('node:crypto');",
      "const rows = Object.entries(process.env).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]);",
      "console.log(JSON.stringify(rows));",
    ].join("");
    const result = await runtime.fetchJson<{
      parts: Array<{ state?: { status?: string; output?: string } }>;
    }>(`/session/${session.id}/shell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "build",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(inspect)}`,
      }),
    });
    const shellState = result.parts[0]?.state;
    expect(shellState?.status).toBe("completed");
    expect(shellState?.output?.trim().length).toBeGreaterThan(0);
    const rows = JSON.parse(shellState!.output!) as Array<[string, string]>;
    const names = rows.map(([key]) => key);
    expect(rows.length).toBeGreaterThan(0);
    expect(names).toContain("PATH");
    expect(rows).toContainEqual([
      "COLORTERM",
      sha256("sapiom-native-environment-probe"),
    ]);
    expect(rows).toContainEqual(["HOME", sha256(hostileHome)]);
    for (const key of [
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_SERVER_USERNAME",
      "OPENCODE_SERVER_PASSWORD",
      "SAPIOM_API_KEY",
      "ANTHROPIC_API_KEY",
    ])
      expect(names).not.toContain(key);
    const nativePassword = Buffer.from(
      nativeAuthorization.slice("Basic ".length),
      "base64",
    )
      .toString("utf8")
      .slice("opencode:".length);
    const forbiddenHashes = [
      runtimeToken,
      `Bearer ${runtimeToken}`,
      nativePassword,
      "synthetic-host-key",
      "synthetic-provider-key",
    ].map(sha256);
    expect(rows.some(([, hash]) => forbiddenHashes.includes(hash))).toBe(false);

    const [unauthenticated, wrongPassword, authenticated] = await Promise.all([
      realFetch(`${nativeOrigin}/global/health`),
      realFetch(`${nativeOrigin}/global/health`, {
        headers: { Authorization: "Basic invalid" },
      }),
      runtime.fetch("/global/health"),
    ]);
    expect(unauthenticated.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(authenticated.status).toBe(200);
    await Promise.all([
      unauthenticated.body?.cancel(),
      wrongPassword.body?.cancel(),
      authenticated.body?.cancel(),
    ]);

    await expectMissing(projectMarker);
    await expectMissing(globalMarker);
    await expectMissing(homeDotMarker);
    await expectMissing(configuredMarker);
    const nativeConfig = await runtime.fetchJson<{ plugin?: string[] }>(
      "/config",
    );
    expect(nativeConfig.plugin).toHaveLength(1);
    expect(nativeConfig.plugin?.[0]).toContain("credential-isolation.mjs");
  }, 30_000);

  it("authenticates model and MCP requests and rejects a revoked runtime credential", async () => {
    const token = "synthetic-bridge-grant";
    const synthetic = await startSyntheticBridge(token);
    runtime = await startOpenCodeServer({
      cwd: root,
      stateRoot: join(root, "state"),
      config: createSapiomOpenCodeConfig({
        bridgeUrl: `${synthetic.origin}/runtime`,
        runtimeToken: token,
      }),
    });

    let statuses: Record<string, { status?: string }> = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      statuses = await runtime.fetchJson("/mcp");
      if (statuses.sapiom?.status === "connected") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(statuses.sapiom?.status).toBe("connected");
    expect(synthetic.state.mcpAuthorized).toBeGreaterThan(0);

    const session = await runtime.fetchJson<{ id: string }>("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const reply = await runtime.fetchJson<{
      parts: Array<{ type?: string; text?: string }>;
    }>(`/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "reply" }] }),
    });
    expect(reply.parts).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: "synthetic native reply",
      }),
    );
    expect(synthetic.state.modelAuthorized).toBeGreaterThan(0);

    synthetic.state.valid = false;
    const disconnected = await runtime.fetch(`/mcp/sapiom/disconnect`, {
      method: "POST",
    });
    await disconnected.body?.cancel();
    const reconnect = await runtime.fetch(`/mcp/sapiom/connect`, {
      method: "POST",
    });
    expect(reconnect.ok).toBe(true);
    await reconnect.body?.cancel();
    statuses = await runtime.fetchJson("/mcp");
    expect(statuses.sapiom?.status).toBe("failed");

    const stale = await runtime.fetchJson<{
      info?: { error?: unknown };
      parts?: Array<{ text?: string }>;
    }>(`/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "again" }] }),
    });
    expect(stale.info?.error).toBeDefined();
    expect(stale.parts ?? []).not.toContainEqual(
      expect.objectContaining({ text: "synthetic native reply" }),
    );
    expect(synthetic.state.rejected).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("fails startup closed when the controlled scrubber cannot load", async () => {
    const stateRoot = join(root, "state");
    const realFetch = globalThis.fetch;
    let removed = false;
    let nativeOrigin = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const response = await realFetch(input, init);
      if (
        !removed &&
        url.pathname === "/global/health" &&
        new Headers(init?.headers).has("Authorization") &&
        response.ok
      ) {
        removed = true;
        nativeOrigin = url.origin;
        const launch = (await readdir(stateRoot)).find((entry) =>
          entry.startsWith("launch-"),
        );
        if (!launch) throw new Error("launch root not found");
        await rm(join(stateRoot, launch, "credential-isolation.mjs"));
      }
      return response;
    });

    await expect(
      startOpenCodeServer({
        cwd: root,
        stateRoot,
        startupTimeoutMs: 2_000,
        config: createSapiomOpenCodeConfig({
          bridgeUrl: "http://127.0.0.1:9/runtime",
          runtimeToken: "synthetic-fail-closed-token",
        }),
      }),
    ).rejects.toMatchObject({ code: "timed-out", retryable: true });
    expect(removed).toBe(true);
    await expect(realFetch(`${nativeOrigin}/global/health`)).rejects.toThrow();
    expect(
      (await readdir(stateRoot)).filter((entry) => entry.startsWith("launch-")),
    ).toEqual([]);
  }, 30_000);
});
