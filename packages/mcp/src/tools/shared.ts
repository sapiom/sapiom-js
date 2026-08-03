/**
 * The preamble every networked tool module shares: build a client from the
 * cached credential, bail with a consistent not-authenticated result, and shape
 * success/failure into a CallToolResult.
 *
 * Extracted from `agents.ts` when a second module (`feedback.ts`) needed the
 * same three lines. It lives in its own module rather than being exported from
 * `agents.ts` so that a tool module never has to import another tool module —
 * that edge would be a cycle waiting to happen, and `agents.ts` is not a
 * utility.
 *
 * `sandbox.ts` still has its own near-twins, and they are NOT equivalent: its
 * `fail` keys off `PreviewOperationError` rather than `AgentOperationError`,
 * and its `ok` predates the serialization fallback below, so a value that
 * `JSON.stringify` chokes on throws there and degrades gracefully here.
 * Converging them means widening `fail`'s guard (both error classes expose an
 * identical `toStructured()`), which is a behavioral change to the sandbox
 * tools and belongs in its own change rather than riding along with this one.
 */
import {
  AgentOperationError,
  createClient,
  GatewayClient,
} from "@sapiom/agent-core";

import { readCredentials, type ResolvedEnvironment } from "../credentials.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function ok(data: unknown): ToolResult {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2);
  } catch (err) {
    // A value in the result resisted serialization. Don't drop the whole
    // payload (e.g. a run_local trace) on the floor — emit a sanitized version
    // that keeps everything serializable and marks the node that failed, so the
    // result stays actionable instead of surfacing as an opaque crash.
    text = JSON.stringify(
      {
        _serializationError: err instanceof Error ? err.message : String(err),
        data: sanitize(data),
      },
      null,
      2,
    );
  }
  return { content: [{ type: "text" as const, text }] };
}

/** Best-effort deep copy that replaces any node which throws on access or
 *  serialization with a marker, so a single bad value can't sink the response. */
function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      try {
        out[key] = sanitize((value as Record<string, unknown>)[key], seen);
      } catch (err) {
        out[key] =
          `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }
    return out;
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/**
 * Shape a thrown value as the structured `{"error": {code, message, hint?}}`
 * envelope. The JSON matters beyond readability: `registerTool` parses
 * `error.code` out of it to classify the `tool.call` analytics event, so a
 * plain-prose error degrades every failure to the `"tool_error"` bucket.
 */
export function fail(err: unknown): ToolResult {
  const structured =
    err instanceof AgentOperationError
      ? err.toStructured()
      : {
          code: "UNEXPECTED",
          message: err instanceof Error ? err.message : String(err),
        };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: structured }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * A client for the resolved environment, or `null` when no credential is
 * cached. Re-reads the credentials file on every call rather than using the
 * startup snapshot in `env.credentials`, so a mid-session `sapiom_authenticate`
 * takes effect immediately.
 */
export async function gatewayClient(
  env: ResolvedEnvironment,
): Promise<GatewayClient | null> {
  const creds = await readCredentials(env.name);
  if (!creds) return null;
  return createClient({ apiKey: creds.apiKey, host: env.apiURL });
}

export const NOT_AUTHED = fail(
  new AgentOperationError({
    code: "NOT_AUTHENTICATED",
    message: "Not authenticated.",
    hint: "Use the sapiom_authenticate tool first.",
  }),
);
