/**
 * The single seam every tool registration goes through, so argument privacy and
 * telemetry isolation from tool results follow one policy.
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
 * Local-only tools' inputs (test inputs, stubs) can hold real secrets that never
 * reach Sapiom otherwise, so `"shape"` keeps only argument names and sizes.
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
 * Synchronous and never throws, so telemetry cannot change a tool result. Field
 * truncation lives in `analytics-core/src/data.ts`.
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

/** Keeps how large each argument was without recording its possibly secret value. */
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
