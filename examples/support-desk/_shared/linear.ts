/**
 * Linear, through the tenant's Linear connector (`@sapiom/tools` `connectors.linear`, the MCP
 * relay with slug `linear`). The relay serves Linear's own MCP tools; nothing here is a Sapiom verb.
 *
 * Tool names and arguments pinned from `tools/list` in a live tenant, 2026-10-01 (76 tools):
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
import { connectors, type McpCallToolResult } from "@sapiom/tools";

import type { SlackCtx } from "./slack";

export const LINEAR_RELAY_SLUG = "linear";
export const LINEAR_TOOLS = {
  createIssue: "save_issue",
  getIssue: "get_issue",
  comment: "save_comment",
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

type LinearApi = typeof connectors.linear;

/** `ctx.sapiom.connectors.linear` in a step (run attribution), the ambient client otherwise. */
function api(ctx?: SlackCtx): LinearApi {
  const fromCtx = (
    ctx?.sapiom as { connectors?: { linear?: LinearApi } } | undefined
  )?.connectors?.linear;
  return fromCtx ?? connectors.linear;
}

export async function listTools(ctx?: SlackCtx): Promise<McpTool[]> {
  return (await api(ctx).listTools()) as McpTool[];
}

/** Call one Linear MCP tool and parse its JSON text block. A relay or tool error throws. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: SlackCtx,
): Promise<Record<string, unknown>> {
  let result: McpCallToolResult;
  try {
    result = await api(ctx).callTool(name, args);
  } catch (err) {
    throw new LinearRelayError(
      `linear relay ${name}: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  const text =
    (
      result.content.find((c) => c.type === "text") as
        { text?: string } | undefined
    )?.text ?? "";
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
  return toLinearIssue(await callTool(LINEAR_TOOLS.createIssue, args, ctx));
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
    await callTool(LINEAR_TOOLS.getIssue, { id: idOrIdentifier }, ctx),
  );
}

/** Local traces must not write comments to Linear. */
export async function commentIssue(
  ctx: SlackCtx,
  issueId: string,
  body: string,
): Promise<void> {
  if (ctx.isLocalTrace) {
    ctx.logger.info("linear save_comment (local trace, not sent)", {
      issueId,
    });
    return;
  }
  await callTool(LINEAR_TOOLS.comment, { issueId, body }, ctx);
}
