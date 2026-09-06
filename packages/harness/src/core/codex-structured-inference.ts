/** Private native-Codex JSON inference bridge. No Studio session, MCP capability, or project environment. */
import { prepareCodexInferenceProfile } from "./codex-inference-profile.js";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const CODEX_INFERENCE_FEATURES = Object.fromEntries(
  [
    "hooks",
    "plugins",
    "remote_plugin",
    "apps",
    "enable_mcp_apps",
    "tool_suggest",
    "workspace_dependencies",
    "shell_tool",
    "unified_exec",
    "shell_snapshot",
    "multi_agent",
    "multi_agent_v2",
    "enable_fanout",
    "code_mode",
    "code_mode_host",
    "code_mode_only",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "standalone_web_search",
    "memories",
    "chronicle",
    "remote_control",
    "deferred_executor",
    "request_permissions_tool",
  ].map((name) => [name, false]),
);

export function codexInferenceRestrictions(
  promptFile: string,
  systemPrompt: string,
  mcpNames: readonly string[] = [],
): Record<string, unknown> {
  return {
    notify: [],
    project_doc_max_bytes: 0,
    model_instructions_file: promptFile,
    developer_instructions: systemPrompt,
    web_search: "disabled",
    skills: { include_instructions: false, bundled: { enabled: false } },
    orchestrator: { skills: { enabled: false } },
    tools: { experimental_request_user_input: { enabled: false } },
    features: CODEX_INFERENCE_FEATURES,
    mcp_servers: Object.fromEntries(
      mcpNames.map((name) => [name, { enabled: false }]),
    ),
  };
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export async function runCodexStructuredInference(
  binary: string,
  input: {
    prompt: string;
    systemPrompt: string;
    schema: Record<string, unknown>;
  },
): Promise<unknown> {
  const cwd = process.cwd();
  const promptFile = join(cwd, "inference-instructions.txt");
  await writeFile(promptFile, input.systemPrompt, { mode: 0o600 });
  const restrictions = codexInferenceRestrictions(
    promptFile,
    input.systemPrompt,
  );
  // Native configuration still selects model/provider/auth. Customization channels are disabled before startup.
  const args = [
    "app-server",
    ...Object.entries(restrictions)
      .filter(([key]) => key !== "mcp_servers")
      .flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
  ];
  // JSON objects aren't TOML inline tables. Pass feature/skill leaves individually.
  const overrides: string[] = [];
  const add = (prefix: string, value: unknown) => {
    const object = record(value);
    if (object)
      for (const [key, child] of Object.entries(object))
        add(`${prefix}.${key}`, child);
    else overrides.push("-c", `${prefix}=${JSON.stringify(value)}`);
  };
  for (const [key, value] of Object.entries(restrictions))
    if (key !== "mcp_servers") add(key, value);
  args.splice(1, args.length - 1, ...overrides);
  const isolatedHome = await prepareCodexInferenceProfile(
    binary,
    cwd,
    overrides,
  );
  const child = spawn(binary, args, {
    cwd,
    env: { ...process.env, CODEX_HOME: isolatedHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {
    /* RPC fails when the process closes */
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let serial = 0;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let output: { turnId: string; text: string } | null = null;
  let ended: { id: string; status: string } | null = null;
  let bytes = 0;
  let resolveTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  // A process can fail before the turn starts; observe immediately and rethrow at the awaited boundary.
  void completion.catch(() => {});
  const fail = () => {
    const error = new Error("Codex structured inference failed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    rejectTurn(error);
  };
  const write = (message: unknown) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  const rpc = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  const stop = () => {
    child.kill("SIGTERM");
    const escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
    escalation.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => {
      fail();
      resolve();
    });
    child.once("close", () => {
      fail();
      resolve();
    });
  });
  // Never pipe native config, auth, model output, or stderr into Studio's generic task stream.
  child.stderr.on("data", () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    bytes += Buffer.byteLength(line);
    if (bytes > 2 * 1024 * 1024) {
      fail();
      stop();
      return;
    }
    let event: Record<string, unknown> | null;
    try {
      event = record(JSON.parse(line));
    } catch {
      fail();
      stop();
      return;
    }
    if (!event) {
      fail();
      return;
    }
    if (typeof event.id === "number" && pending.has(event.id)) {
      const request = pending.get(event.id)!;
      pending.delete(event.id);
      if (event.error) request.reject(new Error("Codex request failed"));
      else request.resolve(event.result);
      return;
    }
    // There are no approvals, interactive input, or dynamic tool calls in this mode.
    if (event.id !== undefined && event.method !== undefined) {
      write({
        id: event.id,
        error: {
          code: -32601,
          message: "Unavailable during structured inference",
        },
      });
      fail();
      stop();
      return;
    }
    const params = record(event.params);
    if (!params || params.threadId !== threadId) return;
    if (event.method === "error" && params.willRetry !== true) {
      fail();
      return;
    }
    if (event.method === "item/started" || event.method === "item/completed") {
      const item = record(params.item);
      const permitted = ["userMessage", "agentMessage", "reasoning", "plan"];
      if (item && !permitted.includes(String(item.type))) {
        fail();
        stop();
        return;
      }
      if (
        event.method === "item/completed" &&
        item?.type === "agentMessage" &&
        item.phase !== "commentary" &&
        typeof item.text === "string" &&
        typeof params.turnId === "string"
      )
        output = { turnId: params.turnId, text: item.text };
    }
    if (event.method === "turn/completed") {
      const turn = record(params.turn);
      if (
        !turn ||
        typeof turn.id !== "string" ||
        turn.status !== "completed" ||
        turn.error
      ) {
        fail();
        return;
      }
      ended = { id: turn.id, status: "completed" };
      resolveTurn();
    }
  });
  try {
    await rpc("initialize", {
      clientInfo: { name: "sapiom-map-inference", version: "1" },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized" });
    const configResponse = record(
      await rpc("config/read", { includeLayers: false, cwd }),
    );
    const config = record(configResponse?.config);
    if (!config) throw new Error("Codex configuration unavailable");
    const thread = record(
      await rpc("thread/start", {
        cwd,
        ephemeral: true,
        environments: [],
        runtimeWorkspaceRoots: [],
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: input.systemPrompt,
        developerInstructions: input.systemPrompt,
        config: codexInferenceRestrictions(
          promptFile,
          input.systemPrompt,
          Object.keys(record(config.mcp_servers) ?? {}),
        ),
      }),
    );
    const id = record(thread?.thread)?.id;
    if (typeof id !== "string") throw new Error("Codex thread unavailable");
    threadId = id;
    const started = record(
      await rpc("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        environments: [],
        runtimeWorkspaceRoots: [],
        approvalPolicy: "never",
        outputSchema: input.schema,
      }),
    );
    const turn = record(started?.turn)?.id;
    if (typeof turn !== "string") throw new Error("Codex turn unavailable");
    turnId = turn;
    await completion;
    // Events are asynchronous to RPC replies. Validate both correlation IDs after the final reply.
    const finalOutput = output as { turnId: string; text: string } | null;
    const finalTurn = ended as { id: string; status: string } | null;
    if (finalTurn?.id !== turnId || finalOutput?.turnId !== turnId)
      throw new Error("Codex result unavailable");
    return JSON.parse(finalOutput.text) as unknown;
  } finally {
    stop();
    await exited;
    lines.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

async function main(): Promise<void> {
  let body = "";
  for await (const chunk of process.stdin) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 256 * 1024)
      throw new Error("Inference input exceeds limit");
  }
  const result = await runCodexStructuredInference(
    process.argv[2]!,
    JSON.parse(body),
  );
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(
      `${JSON.stringify({ type: "result", is_error: false, structured_output: result })}\n`,
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("Codex structured inference failed\n");
    process.exitCode = 1;
  });
}
