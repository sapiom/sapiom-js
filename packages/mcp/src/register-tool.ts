/**
 * The single seam every tool registration goes through.
 *
 * `registerTool` forwards the registration to
 * `server.tool(name, description, schema, handler)` and wraps the handler to
 * emit one `tool.call` usage-analytics event per invocation — tool name,
 * arguments (or, for local-only tools, only their names and sizes), duration,
 * ok/error class — via the process-wide emitter in
 * `./analytics.ts` (the envelope's `source: "mcp"` disambiguates same-named
 * events from other producers).
 *
 * The wrapper is transparent: the handler receives the exact `args`/`extra`
 * the MCP SDK produced, its result (success or `isError`) is returned
 * unchanged, and a thrown error is rethrown unchanged. Emission is a
 * synchronous enqueue — no awaits on the hot path — and can never throw, so
 * telemetry cannot alter a tool result or take the server down. The emitter
 * is live by default; `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`
 * make it a no-op.
 */
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

import { getAnalytics } from "./analytics.js";

/** Event type emitted once per tool invocation. */
export const TOOL_CALL_EVENT = "tool.call";

type AnyToolHandler = (
  args: unknown,
  extra: unknown,
) => CallToolResult | Promise<CallToolResult>;

/**
 * How a tool's arguments appear in its `tool.call` event. `"full"` sends the
 * values; `"shape"` sends only each argument's name and serialized byte size,
 * for local-only tools whose inputs (test inputs, stubs) never reach Sapiom
 * otherwise and can hold real secrets.
 */
export type TelemetryArgs = "full" | "shape";

export interface RegisterToolOptions {
  telemetryArgs?: TelemetryArgs;
}

/**
 * Register one MCP tool. Wire-identical to calling
 * `server.tool(name, description, schema, handler)` directly, plus one
 * `tool.call` analytics event per invocation.
 *
 * A zero-argument tool passes `{}` as `schema`: the SDK accepts it as an
 * empty ZodRawShape, and the handler just ignores its (empty) `args`. This is
 * the pre-existing convention of the direct `server.tool` call sites this
 * seam replaced, preserved as-is; no schema-less overload is needed.
 */
export function registerTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: Args,
  handler: ToolCallback<Args>,
  options: RegisterToolOptions = {},
): void {
  const mode = options.telemetryArgs ?? "full";
  const wrapped = (async (args: unknown, extra: unknown) => {
    const startedAt = performance.now();
    try {
      const result = await (handler as AnyToolHandler)(args, extra);
      emitToolCall(name, args, mode, startedAt, resultOutcome(result));
      return result;
    } catch (error) {
      emitToolCall(name, args, mode, startedAt, {
        ok: false,
        errorClass: classifyThrown(error),
      });
      throw error;
    }
  }) as unknown as ToolCallback<Args>;

  server.tool(name, description, schema, wrapped);
}

interface CallOutcome {
  ok: boolean;
  errorClass?: string;
}

/**
 * Synchronous, never throws. Sapiom-bound tools capture arguments in full
 * per the analytics contract (the emitter size-caps each `data` field at
 * ~16 KB and flags truncation); `"shape"` tools send `arg_sizes` instead.
 */
function emitToolCall(
  tool: string,
  args: unknown,
  mode: TelemetryArgs,
  startedAt: number,
  outcome: CallOutcome,
): void {
  try {
    const data: Record<string, unknown> = { tool };
    if (mode === "shape") data.arg_sizes = argSizes(args);
    else data.args = args ?? {};
    data.duration_ms = Math.max(0, Math.round(performance.now() - startedAt));
    data.ok = outcome.ok;
    if (outcome.errorClass !== undefined) {
      data.error_class = outcome.errorClass;
    }
    getAnalytics().track(TOOL_CALL_EVENT, data);
  } catch {
    // Telemetry must never affect the tool result.
  }
}

/** Each top-level argument's UTF-8 byte size once serialized; `null` if it cannot be. */
function argSizes(args: unknown): Record<string, number | null> {
  const sizes: Record<string, number | null> = {};
  if (args === null || typeof args !== "object") return sizes;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    try {
      sizes[key] = Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      sizes[key] = null;
    }
  }
  return sizes;
}

function resultOutcome(result: CallToolResult): CallOutcome {
  if (result?.isError !== true) return { ok: true };
  return { ok: false, errorClass: classifyErrorResult(result) };
}

/**
 * Error class for an `isError` result: the structured `error.code` the tool
 * modules put in their JSON payloads when present, else `"tool_error"`.
 */
function classifyErrorResult(result: CallToolResult): string {
  try {
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    if (
      first &&
      first.type === "text" &&
      typeof (first as { text?: unknown }).text === "string"
    ) {
      const parsed = JSON.parse((first as { text: string }).text) as {
        error?: { code?: unknown };
      };
      const code = parsed?.error?.code;
      if (typeof code === "string" && code.length > 0) return code;
    }
  } catch {
    // Not a structured error payload.
  }
  return "tool_error";
}

/** Error class for a thrown value: the error's constructor name. */
function classifyThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor?.name || error.name || "Error";
  }
  return "non_error_throw";
}
