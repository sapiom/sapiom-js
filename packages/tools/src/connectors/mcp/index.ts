/**
 * `mcp` capability — a client for the connectors gateway's MCP relay, which serves a
 * tenant's MCP-backed connector (Linear, Notion, or a custom MCP server) as an MCP
 * server. The relay resolves the tenant's credential INTERNALLY and forwards the call
 * to the provider's own MCP server — the token NEVER crosses this boundary.
 *
 *   import { connectors } from "@sapiom/tools";
 *   const tools = await connectors.linear.listTools();
 *   const result = await connectors.linear.callTool("list_issues", { limit: 5 });
 *
 * Or on the step context: `ctx.sapiom.connectors.linear.callTool(...)`, and
 * `ctx.sapiom.connectors.mcp("<slug>")` for any other connector.
 *
 * Wire: `POST ${baseUrl}/connectors/v1/<slug>/mcp`, one JSON-RPC 2.0 request per call
 * (`tools/list` or `tools/call`). The relay is stateless (no `initialize` handshake, no
 * `Mcp-Session-Id`), requires `Accept: application/json, text/event-stream`, and answers
 * with an SSE stream carrying the JSON-RPC response as a `data:` line; a plain JSON
 * body is accepted too.
 *
 * `<slug>` is the connector's slug, derived from its name: a connector added from the
 * Connectors page with its default name (`Linear`, `Notion`) has slug `linear` /
 * `notion`, which is what `connectors.linear` / `connectors.notion` use. A renamed or
 * second connector has a different slug (`linear-2`); pass it to `mcp(slug)`.
 *
 * Errors: a non-2xx (401 bad credential) throws the transport's HTTP error; a JSON-RPC
 * `error` in the response throws {@link McpRelayError}. The relay reports a failed tool
 * call (connector not ready, unknown tool, provider error) as a normal result with
 * `isError: true` and a text explanation, NOT as an error — check `isError`. An
 * unconnected or undiscovered connector lists no tools.
 */
import {
  Transport,
  TransportHttpError,
  defaultTransport,
} from "../../_client/index.js";
import { parseRetryAfterMs, readErrorBody } from "../../_client/errors.js";

// Same tools host agents/models resolve — via SAPIOM_TOOLS_BASE. No new per-cap config.
const DEFAULT_BASE_URL =
  process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai";

/** A tool the connector exposes, as discovered from the provider's MCP server. */
export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's `arguments`. */
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

/** One item of a tool result's `content`. Text is the common case. */
export type McpContent =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

/** The result of {@link McpConnector.callTool}: MCP's `CallToolResult`. */
export interface McpCallToolResult {
  content: McpContent[];
  /** `true` when the call failed; `content` then holds the reason as text. */
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An MCP-backed connector, addressed by slug. */
export interface McpConnector {
  /** Every tool the tenant's connector exposes (empty until connected and discovered). */
  listTools(): Promise<McpTool[]>;
  /** Call one tool by name. Check `isError` on the result. */
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<McpCallToolResult>;
}

/** A JSON-RPC error the relay answered with (e.g. `-32603` relay unavailable). */
export class McpRelayError extends Error {
  /** JSON-RPC error code. */
  readonly code: number;
  /** JSON-RPC error `data`, when present. */
  readonly data: unknown;
  /** The connector slug the request was for. */
  readonly slug: string;
  /** The JSON-RPC method (`tools/list` or `tools/call`). */
  readonly method: string;

  constructor(args: {
    message: string;
    code: number;
    data?: unknown;
    slug: string;
    method: string;
  }) {
    super(args.message);
    this.name = "McpRelayError";
    this.code = args.code;
    this.data = args.data;
    this.slug = args.slug;
    this.method = args.method;
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let nextId = 1;

/** The JSON-RPC response for `id`, from either a JSON body or an SSE stream. */
function parseResponse(
  text: string,
  contentType: string | null,
  id: number,
): JsonRpcResponse | undefined {
  const candidates: unknown[] = [];
  if (contentType?.includes("text/event-stream")) {
    // One event per blank-line-separated block; its `data:` lines join with "\n".
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) candidates.push(JSON.parse(data));
    }
  } else {
    const parsed: unknown = JSON.parse(text);
    candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return candidates.find(
    (m): m is JsonRpcResponse =>
      typeof m === "object" &&
      m !== null &&
      (m as JsonRpcResponse).id === id &&
      ("result" in m || "error" in m),
  );
}

async function rpc<T>(
  slug: string,
  method: string,
  params: Record<string, unknown>,
  transport: Transport,
): Promise<T> {
  const id = nextId++;
  const url = `${DEFAULT_BASE_URL}/connectors/v1/${encodeURIComponent(slug)}/mcp`;
  const res = await transport.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) {
    // The same non-2xx error the method-route connectors throw (via Transport.request).
    const { text, body } = await readErrorBody(res);
    throw new TransportHttpError({
      message: `POST ${url} → ${res.status} ${text}`,
      status: res.status,
      method: "POST",
      url,
      body,
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    });
  }
  const text = await res.text();
  let message: JsonRpcResponse | undefined;
  try {
    message = parseResponse(text, res.headers.get("content-type"), id);
  } catch {
    // Not JSON-RPC at all: report it as a parse error rather than a bare SyntaxError.
    message = undefined;
  }
  if (!message) {
    throw new McpRelayError({
      message: `MCP relay returned no JSON-RPC response for ${method}`,
      code: -32700,
      slug,
      method,
    });
  }
  if (message.error) {
    throw new McpRelayError({
      message: message.error.message,
      code: message.error.code,
      data: message.error.data,
      slug,
      method,
    });
  }
  return message.result as T;
}

/**
 * A client for the MCP-backed connector with this slug (see the module doc for slugs).
 * The default transport is resolved per call, so a module-level `mcp("linear")` picks up
 * the run credential that exists when it is called, not when it was imported.
 */
export function mcp(slug: string, transport?: Transport): McpConnector {
  const t = () => transport ?? defaultTransport();
  return {
    async listTools() {
      const tools: McpTool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await rpc<{ tools: McpTool[]; nextCursor?: string }>(
          slug,
          "tools/list",
          cursor === undefined ? {} : { cursor },
          t(),
        );
        tools.push(...page.tools);
        cursor = page.nextCursor;
        // A relay that hands back a cursor it already gave would page forever.
        if (cursor) {
          if (seen.has(cursor)) {
            throw new McpRelayError({
              message: "MCP relay returned a repeated cursor for tools/list",
              code: -32603,
              data: { cursor },
              slug,
              method: "tools/list",
            });
          }
          seen.add(cursor);
        }
      } while (cursor);
      return tools;
    },
    callTool(name, args) {
      return rpc<McpCallToolResult>(
        slug,
        "tools/call",
        { name, arguments: args ?? {} },
        t(),
      );
    },
  };
}

/** The tenant's Linear connector (slug `linear`). */
export const linear: McpConnector = mcp("linear");

/** The tenant's Notion connector (slug `notion`). */
export const notion: McpConnector = mcp("notion");
