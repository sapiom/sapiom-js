import { randomBytes, scryptSync } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSapiomOpenCodeConfig } from "./config.js";
import { startOpenCodeServer, type OpenCodeServer } from "./server.js";

let root: string;
let runtime: OpenCodeServer | undefined;
let bridge: Server | undefined;
const nativeStartupTimeoutMs = 30_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-native-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await runtime?.close();
  runtime = undefined;
  await new Promise<void>(
    (resolve) => bridge?.close(() => resolve()) ?? resolve(),
  );
  bridge = undefined;
  await rm(root, { recursive: true, force: true });
});

function environmentTag(value: string, salt: string): string {
  return scryptSync(value, salt, 32).toString("hex");
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? (JSON.parse(body) as unknown) : undefined;
}

interface ModelRequest extends Record<string, unknown> {
  tools?: Array<{ type: string; name: string }>;
  input?: Array<{ type?: string; [key: string]: unknown }>;
}

async function startSyntheticBridge(token: string) {
  const state = {
    valid: true,
    modelAuthorized: 0,
    mcpAuthorized: 0,
    rejected: 0,
    requests: [] as string[],
    modelRequests: [] as ModelRequest[],
    toolCalls: [] as unknown[],
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
        params?: {
          protocolVersion?: string;
          name?: string;
          arguments?: { a: number; b: number };
        };
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
            ? {
                tools: [
                  {
                    name: "probe_add",
                    description: "Add two integers",
                    inputSchema: {
                      type: "object",
                      properties: {
                        a: { type: "integer" },
                        b: { type: "integer" },
                      },
                      required: ["a", "b"],
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? {
                  content: [
                    {
                      type: "text",
                      text: String(
                        (message.params?.arguments?.a ?? 0) +
                          (message.params?.arguments?.b ?? 0),
                      ),
                    },
                  ],
                }
              : {};
      if (message.method === "tools/call") state.toolCalls.push(message.params);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      return;
    }
    if (url.pathname.endsWith("/responses")) {
      state.modelAuthorized++;
      const body = (await readRequestBody(request)) as ModelRequest;
      state.modelRequests.push(body);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const emit = (type: string, fields: object) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
        );
      const id = `resp_${state.modelAuthorized}`;
      const reasonId = `rs_${state.modelAuthorized}`;
      const reason = {
        id: reasonId,
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Synthetic reasoning" }],
        encrypted_content: "encrypted-synthetic-reasoning",
        status: "completed",
      };
      const base = { id, object: "response", created_at: 1, model: "gpt-luna" };
      emit("response.created", {
        response: { ...base, status: "in_progress", output: [] },
      });
      emit("response.output_item.added", {
        output_index: 0,
        item: { ...reason, status: "in_progress", summary: [] },
      });
      emit("response.reasoning_summary_part.added", {
        item_id: reasonId,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      emit("response.reasoning_summary_text.delta", {
        item_id: reasonId,
        output_index: 0,
        summary_index: 0,
        delta: "Synthetic reasoning",
      });
      emit("response.reasoning_summary_text.done", {
        item_id: reasonId,
        output_index: 0,
        summary_index: 0,
        text: "Synthetic reasoning",
      });
      emit("response.output_item.done", { output_index: 0, item: reason });
      const tool = body.tools?.find(
        (tool: { type: string; name: string }) =>
          tool.type === "function" && tool.name === "execute",
      );
      const hasResult = body.input?.some(
        (item: { type?: string }) => item.type === "function_call_output",
      );
      let output;
      if (tool && !hasResult && body.tool_choice !== "none") {
        output = {
          id: "fc_once",
          type: "function_call",
          call_id: "call_once",
          name: tool.name,
          arguments: JSON.stringify({
            code: "return await tools.sapiom.probe_add({a:2,b:3})",
          }),
          status: "completed",
        };
        emit("response.output_item.added", {
          output_index: 1,
          item: { ...output, arguments: "", status: "in_progress" },
        });
        emit("response.function_call_arguments.delta", {
          item_id: output.id,
          output_index: 1,
          delta: output.arguments,
        });
        emit("response.function_call_arguments.done", {
          item_id: output.id,
          output_index: 1,
          arguments: output.arguments,
        });
      } else {
        output = {
          id: `msg_${state.modelAuthorized}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "synthetic native reply",
              annotations: [],
            },
          ],
          status: "completed",
        };
        emit("response.output_item.added", {
          output_index: 1,
          item: { ...output, content: [], status: "in_progress" },
        });
        emit("response.output_text.delta", {
          item_id: output.id,
          output_index: 1,
          content_index: 0,
          delta: "synthetic native reply",
        });
      }
      emit("response.output_item.done", { output_index: 1, item: output });
      emit("response.completed", {
        response: {
          ...base,
          status: "completed",
          output: [reason, output],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
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
    const tagSalt = randomBytes(16).toString("hex");
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
      startupTimeoutMs: nativeStartupTimeoutMs,
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
      "const { scryptSync } = require('node:crypto');",
      `const tagSalt = ${JSON.stringify(tagSalt)};`,
      "const rows = Object.entries(process.env).map(([key, value]) => [key, scryptSync(value, tagSalt, 32).toString('hex')]);",
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
      environmentTag("sapiom-native-environment-probe", tagSalt),
    ]);
    expect(rows).toContainEqual(["HOME", environmentTag(hostileHome, tagSalt)]);
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
    const forbiddenTags = [
      runtimeToken,
      `Bearer ${runtimeToken}`,
      nativePassword,
      "synthetic-host-key",
      "synthetic-provider-key",
    ].map((value) => environmentTag(value, tagSalt));
    expect(rows.some(([, tag]) => forbiddenTags.includes(tag))).toBe(false);

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
  }, 60_000);

  it("uses Luna Responses for a complete MCP tool round trip and rejects a revoked runtime credential", async () => {
    const token = "synthetic-bridge-grant";
    const synthetic = await startSyntheticBridge(token);
    runtime = await startOpenCodeServer({
      cwd: root,
      stateRoot: join(root, "state"),
      startupTimeoutMs: nativeStartupTimeoutMs,
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
    expect(
      synthetic.state.toolCalls,
      JSON.stringify(
        synthetic.state.modelRequests.map((body) =>
          body.tools?.map((tool) => tool.name),
        ),
      ),
    ).toEqual([
      expect.objectContaining({ name: "probe_add", arguments: { a: 2, b: 3 } }),
    ]);
    for (const body of synthetic.state.modelRequests) {
      expect(body).toMatchObject({
        model: "gpt-luna",
        reasoning: { effort: "low", summary: "auto" },
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      expect(body).not.toHaveProperty("previous_response_id");
    }
    const continued = synthetic.state.modelRequests.find((body) =>
      body.input?.some(
        (item: { type?: string }) => item.type === "function_call_output",
      ),
    );
    expect(continued?.input).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_once",
      }),
    );
    expect(continued?.input).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: "encrypted-synthetic-reasoning",
      }),
    );
    expect(
      synthetic.state.requests.some((path) =>
        path.endsWith("/chat/completions"),
      ),
    ).toBe(false);

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
  }, 60_000);

  it("does not expose its isolated native home to a tool when caller HOME is absent", async () => {
    const callerProfile = join(root, "caller-profile");
    const environment = {
      ...process.env,
      HOME: undefined,
      USERPROFILE: callerProfile,
    };
    runtime = await startOpenCodeServer({
      cwd: root,
      stateRoot: join(root, "state"),
      startupTimeoutMs: nativeStartupTimeoutMs,
      environment,
      config: createSapiomOpenCodeConfig({
        bridgeUrl: "http://127.0.0.1:9/runtime",
        runtimeToken: "synthetic-home-semantics-token",
      }),
    });
    const session = await runtime.fetchJson<{ id: string }>("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const inspect =
      "console.log(JSON.stringify({home:process.env.HOME ?? null,profile:process.env.USERPROFILE}))";
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
    const childEnvironment = JSON.parse(shellState!.output!) as {
      home: string | null;
      profile: string;
    };
    expect(childEnvironment.profile).toBe(callerProfile);
    expect(childEnvironment.home).toBe(callerProfile);
  }, 60_000);

  it("uses the OS account home when the supplied environment has no home family", async () => {
    const ambientHome = join(root, "hostile-ambient-home");
    vi.stubEnv("HOME", ambientHome);
    const environment = {
      ...process.env,
      HOME: undefined,
      USERPROFILE: undefined,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
    };
    runtime = await startOpenCodeServer({
      cwd: root,
      stateRoot: join(root, "state"),
      startupTimeoutMs: nativeStartupTimeoutMs,
      environment,
      config: createSapiomOpenCodeConfig({
        bridgeUrl: "http://127.0.0.1:9/runtime",
        runtimeToken: "synthetic-account-home-token",
      }),
    });
    const session = await runtime.fetchJson<{ id: string }>("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const inspect =
      "console.log(JSON.stringify({home:process.env.HOME,profile:process.env.USERPROFILE}))";
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
    expect(JSON.parse(shellState!.output!)).toEqual({
      home: userInfo().homedir,
      profile: userInfo().homedir,
    });
    expect(shellState!.output!).not.toContain(ambientHome);
    expect(shellState!.output!).not.toContain(
      `${join(root, "state", "launch-")}`,
    );
  }, 60_000);

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
        startupTimeoutMs: 5_000,
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
