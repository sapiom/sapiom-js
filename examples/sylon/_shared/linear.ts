/**
 * Linear, through the tenant's Linear connector: the MCP relay at
 * `POST {tools}/connectors/v1/linear/mcp` (JSON-RPC over streamable HTTP, stateless) on the run's
 * credential. The relay serves Linear's own MCP tools; nothing here is a Sapiom verb.
 *
 * Tool names and arguments pinned from `tools/list` on Sapiom Internal, 2026-10-01 (76 tools):
 *
 *   save_issue  create when `id` is absent. Args used here: team (name or id, required on create),
 *               title, description (markdown), project (name, id or slug), priority
 *               (0 none, 1 urgent, 2 high, 3 medium, 4 low), links [{ url, title }].
 *               Also: id, state, assignee, labels, parentId, ...
 *   get_issue   id (issue id or identifier such as SAP-123), includeRelations?
 *
 * Both return one text content block holding JSON; `id` there is the identifier (SAP-123) and
 * `uuid` is the Linear id. On a local trace nothing is sent and a stub issue comes back.
 */
import type { SlackCtx } from "./slack";

export const LINEAR_RELAY_SLUG = "linear";
export const LINEAR_TOOLS = {
  createIssue: "save_issue",
  getIssue: "get_issue",
} as const;

export interface LinearIssue {
  /** Linear's uuid. */
  id: string;
  /** Human identifier, e.g. SAP-123. */
  identifier: string;
  url: string;
  status?: string;
  statusType?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class LinearRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearRelayError";
  }
}

let rpcId = 0;

/** Parse a streamable-HTTP MCP reply, which is either JSON or one SSE `data:` frame. */
export function parseMcpReply(body: string): {
  result?: unknown;
  error?: { message?: string };
} {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data)
    throw new LinearRelayError(`empty MCP reply: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data);
}

export async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const key = process.env.SAPIOM_API_KEY;
  if (!key)
    throw new LinearRelayError(
      "SAPIOM_API_KEY is not set; the Linear relay needs the run credential",
    );
  const base = (
    process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai"
  ).replace(/\/+$/, "");
  const res = await fetch(`${base}/connectors/v1/${LINEAR_RELAY_SLUG}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-sapiom-api-key": key,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if (!res.ok)
    throw new LinearRelayError(
      `linear relay ${method} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  const reply = parseMcpReply(text);
  if (reply.error)
    throw new LinearRelayError(
      `linear relay ${method}: ${reply.error.message ?? "error"}`,
    );
  return reply.result;
}

export async function listTools(): Promise<McpTool[]> {
  const result = (await mcpRequest("tools/list", {})) as { tools?: McpTool[] };
  return result.tools ?? [];
}

/** Call one Linear MCP tool and parse its JSON text block. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = (await mcpRequest("tools/call", {
    name,
    arguments: args,
  })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError)
    throw new LinearRelayError(`linear ${name}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new LinearRelayError(
      `linear ${name} returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
}

export function toLinearIssue(raw: Record<string, unknown>): LinearIssue {
  const identifier = String(raw.identifier ?? raw.id ?? "");
  const id = String(raw.uuid ?? raw.id ?? "");
  if (!identifier || !id)
    throw new LinearRelayError(
      `linear issue without id: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  return {
    id,
    identifier,
    url: String(raw.url ?? ""),
    status: typeof raw.status === "string" ? raw.status : undefined,
    statusType: typeof raw.statusType === "string" ? raw.statusType : undefined,
  };
}

export async function createIssue(
  ctx: SlackCtx,
  input: {
    teamId: string;
    title: string;
    description: string;
    projectId?: string;
    priority?: number;
    links?: { url: string; title: string }[];
  },
): Promise<LinearIssue> {
  if (ctx.isLocalTrace) {
    ctx.logger.info("linear save_issue (local trace, not sent)", {
      title: input.title,
    });
    return {
      id: "00000000-0000-4000-8000-00000000c0de",
      identifier: "LOCAL-1",
      url: "https://linear.app/local/issue/LOCAL-1",
    };
  }
  const args: Record<string, unknown> = {
    team: input.teamId,
    title: input.title,
    description: input.description,
  };
  if (input.projectId) args.project = input.projectId;
  if (input.priority !== undefined) args.priority = input.priority;
  if (input.links?.length) args.links = input.links;
  return toLinearIssue(await callTool(LINEAR_TOOLS.createIssue, args));
}

export async function getIssue(
  ctx: SlackCtx,
  idOrIdentifier: string,
): Promise<LinearIssue> {
  if (ctx.isLocalTrace) {
    ctx.logger.info("linear get_issue (local trace, not sent)", {
      id: idOrIdentifier,
    });
    return {
      id: idOrIdentifier,
      identifier: idOrIdentifier,
      url: "",
      status: "Todo",
      statusType: "unstarted",
    };
  }
  return toLinearIssue(
    await callTool(LINEAR_TOOLS.getIssue, { id: idOrIdentifier }),
  );
}
