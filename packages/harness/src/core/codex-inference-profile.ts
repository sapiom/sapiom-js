import { DurableFileLock } from "./durable-file-lock.js";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Snapshot only provider/model preferences; never inherit tools, hooks, instructions or MCP definitions. */
export function codexInferenceConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const effective = config;
  const allowed = [
    "model",
    "model_provider",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
    "model_context_window",
    "model_auto_compact_token_limit",
    "model_supports_reasoning_summaries",
    "service_tier",
    "openai_base_url",
    "chatgpt_base_url",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
  ];
  const providers = object(effective.model_providers);
  const providerName =
    typeof effective.model_provider === "string"
      ? effective.model_provider
      : "openai";
  const provider = object(providers?.[providerName]);
  if (provider?.auth)
    throw new Error(
      "Executable provider authentication is unavailable during isolated inference",
    );
  const providerKeys = [
    "name",
    "base_url",
    "wire_api",
    "env_key",
    "experimental_bearer_token",
    "http_headers",
    "env_http_headers",
    "query_params",
    "requires_openai_auth",
    "supports_websockets",
    "request_max_retries",
    "stream_max_retries",
    "stream_idle_timeout_ms",
    "websocket_connect_timeout_ms",
  ];
  return {
    ...(provider
      ? {
          model_providers: {
            [providerName]: Object.fromEntries(
              providerKeys
                .filter((key) => provider[key] !== undefined)
                .map((key) => [key, provider[key]]),
            ),
          },
        }
      : {}),
    ...Object.fromEntries(
      allowed
        .filter(
          (key) => effective[key] !== undefined && effective[key] !== null,
        )
        .map((key) => [key, effective[key]]),
    ),
    cli_auth_credentials_store: "file",
    notify: [],
    project_doc_max_bytes: 0,
    web_search: "disabled",
  };
}

/** JSON strings are valid TOML strings. Object keys are quoted, including dots in provider names. */
export function inferenceConfigToml(config: Record<string, unknown>): string {
  const value = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(value).join(",")}]`;
    const record = object(item);
    if (record)
      return `{${Object.entries(record)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${JSON.stringify(k)}=${value(v)}`)
        .join(",")}}`;
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    )
      return JSON.stringify(item);
    throw new Error("Unsupported provider configuration");
  };
  return Object.entries(config)
    .map(([key, item]) => `${JSON.stringify(key)}=${value(item)}`)
    .join("\n");
}

/** The ephemeral worker may use a refreshed access token, but must NEVER rotate the native refresh token. */
export function inferenceAuthSnapshot(
  raw: unknown,
  nowSeconds = Date.now() / 1000,
): Record<string, unknown> {
  const auth = object(raw);
  if (!auth) throw new Error("Native provider authentication unavailable");
  if (
    auth.auth_mode !== "chatgpt" &&
    typeof auth.OPENAI_API_KEY === "string" &&
    auth.OPENAI_API_KEY
  )
    return { OPENAI_API_KEY: auth.OPENAI_API_KEY };
  const tokens = object(auth.tokens);
  if (!tokens || typeof tokens.access_token !== "string")
    throw new Error("Native provider authentication unavailable");
  const payload = tokens.access_token.split(".")[1];
  const claims = payload
    ? object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    : null;
  if (typeof claims?.exp !== "number" || claims.exp < nowSeconds + 240)
    throw new Error("Native provider login needs refresh");
  return { ...auth, tokens: { ...tokens, refresh_token: "" } };
}

/** Original-home broker does configuration/auth only; it never starts a thread or any MCP server. */
export async function prepareCodexInferenceProfile(
  binary: string,
  cwd: string,
  startupArgs: string[],
): Promise<string> {
  const originalHome = await fs.realpath(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  );
  // Only the original AuthManager may rotate a native refresh token, one Studio broker at a time.
  const releaseAuth = await new DurableFileLock(
    join(originalHome, "studio-inference-auth"),
    { timeoutMs: 180000 },
  ).acquire();
  const broker = spawn(binary, ["app-server", ...startupArgs], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  broker.stdin.on("error", () => {});
  broker.stderr.on("data", () => {});
  let serial = 0;
  let bytes = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const fail = () => {
    for (const request of pending.values())
      request.reject(new Error("Native provider setup failed"));
    pending.clear();
  };
  const closed = new Promise<void>((resolve) => {
    broker.once("error", () => {
      fail();
      resolve();
    });
    broker.once("close", () => {
      fail();
      resolve();
    });
  });
  const stop = () => {
    broker.kill("SIGTERM");
    const timer = setTimeout(() => broker.kill("SIGKILL"), 1000);
    timer.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const lines = createInterface({ input: broker.stdout });
  lines.on("line", (line) => {
    bytes += Buffer.byteLength(line);
    if (bytes > 2 * 1024 * 1024) {
      fail();
      stop();
      return;
    }
    let event: Record<string, unknown> | null;
    try {
      event = object(JSON.parse(line));
    } catch {
      fail();
      stop();
      return;
    }
    if (typeof event?.id !== "number") return;
    const request = pending.get(event.id);
    if (!request) return;
    pending.delete(event.id);
    if (event.error) request.reject(new Error("Native provider setup failed"));
    else request.resolve(event.result);
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      broker.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "sapiom-map-inference-auth", version: "1" },
      capabilities: { experimentalApi: true },
    });
    broker.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const response = object(
      await rpc("config/read", { includeLayers: false, cwd }),
    );
    const config = object(response?.config);
    if (!config) throw new Error("Provider configuration unavailable");
    // The native AuthManager owns any refresh. Do not export its bearer token in the RPC response.
    await rpc("getAuthStatus", { includeToken: false, refreshToken: true });
    const mode = config.cli_auth_credentials_store ?? "file";
    if (mode === "ephemeral")
      throw new Error("Ephemeral native login cannot be transferred");
    let auth: unknown;
    if (object(config.features)?.secret_auth_storage === true)
      throw new Error(
        "Provider credential storage unsupported for isolated inference",
      );
    if (mode === "keyring" || mode === "auto") {
      if (process.platform === "darwin") {
        const account = `cli|${createHash("sha256").update(originalHome).digest("hex").slice(0, 16)}`;
        try {
          const { stdout } = await promisify(execFile)(
            "/usr/bin/security",
            ["find-generic-password", "-s", "Codex Auth", "-a", account, "-w"],
            { maxBuffer: 128 * 1024, timeout: 10000 },
          );
          auth = JSON.parse(stdout);
        } catch {
          if (mode === "keyring")
            throw new Error("Provider keychain unavailable");
        }
      } else if (mode === "keyring")
        throw new Error("Provider keyring unavailable for isolated inference");
    }
    if (!auth) {
      try {
        auth = JSON.parse(
          await fs.readFile(join(originalHome, "auth.json"), "utf8"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Provider login unavailable");
      }
    }
    const isolatedHome = join(cwd, "codex");
    await fs.mkdir(isolatedHome, { mode: 0o700 });
    await fs.writeFile(
      join(isolatedHome, "config.toml"),
      inferenceConfigToml(codexInferenceConfig(config)),
      { mode: 0o600 },
    );
    if (auth)
      await fs.writeFile(
        join(isolatedHome, "auth.json"),
        JSON.stringify(inferenceAuthSnapshot(auth)),
        { mode: 0o600 },
      );
    return isolatedHome;
  } finally {
    stop();
    await closed;
    lines.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await releaseAuth();
  }
}
