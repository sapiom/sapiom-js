/**
 * Slack, through the tenant's Slack connector (`@sapiom/tools` `connectors.slack`). The gateway
 * holds the bot token and calls Slack; the token never enters the run.
 *
 * Calls go through `ctx.sapiom.connectors.slack` when the context has one (a step), so they carry
 * the run's attribution, and through the ambient client on `SAPIOM_API_KEY` otherwise (a laptop
 * script). On a local trace nothing is sent: each call logs and returns a plausible stub, so
 * `run_local` walks the real step code without posting to Slack.
 */
import type { AgentExecutionContext } from "@sapiom/agent";
import { connectors } from "@sapiom/tools";

export type SlackCtx = Pick<
  AgentExecutionContext<Record<string, unknown>>,
  "isLocalTrace" | "logger"
> & { sapiom?: unknown };

export interface SlackMessageRow {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  [key: string]: unknown;
}

export type Block = Record<string, unknown>;

export class SlackMethodError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`slack ${method} failed (${status}): ${detail}`);
    this.name = "SlackMethodError";
  }
}

type SlackApi = typeof connectors.slack;

function api(ctx: SlackCtx): SlackApi {
  const fromCtx = (
    ctx.sapiom as { connectors?: { slack?: SlackApi } } | undefined
  )?.connectors?.slack;
  return fromCtx ?? connectors.slack;
}

/** The gateway's error body names the Slack error (`channel_not_found`, a missing scope, ...). */
function toSlackError(method: string, err: unknown): SlackMethodError {
  const e = err as { status?: unknown; body?: unknown; message?: unknown };
  const status = typeof e?.status === "number" ? e.status : 0;
  const body = e?.body as { message?: unknown; error?: unknown } | undefined;
  const detail =
    (typeof body?.message === "string" && body.message) ||
    (typeof body?.error === "string" && body.error) ||
    (typeof e?.message === "string" ? e.message : String(err));
  return new SlackMethodError(method, status, detail);
}

let localTs = 1_790_000_000;
const stubTs = () => `${++localTs}.000100`;

async function call<T>(
  ctx: SlackCtx,
  method: string,
  args: Record<string, unknown>,
  live: (slack: SlackApi) => Promise<T>,
  stub: () => T,
): Promise<T> {
  if (ctx.isLocalTrace) {
    ctx.logger.info(`slack ${method} (local trace, not sent)`, { args });
    return stub();
  }
  try {
    return await live(api(ctx));
  } catch (err) {
    throw toSlackError(method, err);
  }
}

/**
 * The generic tail for a connector method `connectors.slack` does not wrap. Arg names are the
 * gateway's, which are not always Slack's.
 */
export async function callSlack<T = Record<string, unknown>>(
  ctx: SlackCtx,
  method: string,
  args: Record<string, unknown>,
  stub: () => T,
): Promise<T> {
  if (ctx.isLocalTrace) {
    ctx.logger.info(`slack ${method} (local trace, not sent)`, { args });
    return stub();
  }
  const key = process.env.SAPIOM_API_KEY;
  if (!key)
    throw new Error(
      "SAPIOM_API_KEY is not set; Slack connector methods need the run credential",
    );
  const base = (
    process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai"
  ).replace(/\/+$/, "");
  const res = await fetch(`${base}/connectors/v1/slack/methods/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sapiom-api-key": key },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON; keep the raw text
    }
    throw toSlackError(method, {
      status: res.status,
      body,
      message: text.slice(0, 300),
    });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// SAP-3721: recover a successful Slack post whose database record was not committed.
async function findPosted(
  ctx: SlackCtx,
  channel: string,
  threadTs: string,
  marker: string,
): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const args = {
      channel,
      ts: threadTs,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    };
    const out = await call<Awaited<ReturnType<SlackApi["replies"]>>>(
      ctx,
      "conversations.replies",
      args,
      (s) => s.replies(args),
      () => ({ ok: true as const, messages: [] }),
    );
    const hit = (out.messages ?? []).find(
      (m) => m.bot_id && m.blocks?.some((b) => b.block_id === marker),
    );
    if (hit) return hit.ts;
    cursor = out.has_more ? out.response_metadata?.next_cursor : undefined;
  } while (cursor);
  return undefined;
}

// SAP-3721: retries must recover posts whose database record failed.
// The connector omits Slack metadata, so reconciliation requires a block marker.
export async function post(
  ctx: SlackCtx,
  input: {
    channel: string;
    text?: string;
    blocks?: Block[];
    threadTs?: string;
    key?: string;
  },
): Promise<{ channel: string; ts: string }> {
  const { key, ...args } = input;
  if (key && args.threadTs) {
    const marker = `sylon:${key}`;
    const earlier = await findPosted(ctx, args.channel, args.threadTs, marker);
    if (earlier) return { channel: args.channel, ts: earlier };
    args.blocks = args.blocks?.length
      ? [{ ...args.blocks[0], block_id: marker }, ...args.blocks.slice(1)]
      : // A section's mrkdwn text caps at 3000 characters; a plain text post does not.
        (args.text?.match(/[\s\S]{1,3000}/g) ?? [""]).map((text, i) => ({
          type: "section",
          ...(i === 0 ? { block_id: marker } : {}),
          text: { type: "mrkdwn", text },
        }));
  }
  const out = await call(
    ctx,
    "chat.postMessage",
    args,
    (s) => s.postMessage(args),
    () => ({ ok: true as const, channel: args.channel, ts: stubTs() }),
  );
  if (!out.ts)
    throw new SlackMethodError("chat.postMessage", 200, "no ts in response");
  return { channel: out.channel ?? input.channel, ts: out.ts };
}

export async function update(
  ctx: SlackCtx,
  input: { channel: string; ts: string; text?: string; blocks?: Block[] },
): Promise<void> {
  await call(
    ctx,
    "chat.update",
    input,
    (s) => s.update(input),
    () => ({ ok: true as const, channel: input.channel, ts: input.ts }),
  );
}

/** Visible only to `user`. */
export async function postEphemeral(
  ctx: SlackCtx,
  input: {
    channel: string;
    user: string;
    text?: string;
    blocks?: Block[];
    threadTs?: string;
  },
): Promise<void> {
  await call(
    ctx,
    "chat.postEphemeral",
    input,
    (s) => s.postEphemeral(input),
    () => ({ ok: true as const, message_ts: stubTs() }),
  );
}

async function reaction(
  ctx: SlackCtx,
  method: "reactions.add" | "reactions.remove",
  input: { channel: string; ts: string; name: string },
) {
  const args = {
    channel: input.channel,
    timestamp: input.ts,
    name: input.name,
  };
  try {
    await call(
      ctx,
      method,
      args,
      (s) =>
        method === "reactions.add"
          ? s.addReaction(args)
          : s.removeReaction(args),
      () => ({ ok: true as const }),
    );
  } catch (err) {
    // Reactions are acknowledgements; a rate limit or an already_reacted must never fail a run.
    ctx.logger.warn(`slack ${method} failed; continuing`, {
      err: String(err),
      name: input.name,
    });
  }
}

export const react = (
  ctx: SlackCtx,
  input: { channel: string; ts: string; name: string },
) => reaction(ctx, "reactions.add", input);
export const unreact = (
  ctx: SlackCtx,
  input: { channel: string; ts: string; name: string },
) => reaction(ctx, "reactions.remove", input);

/** The thread rooted at `ts`, root first. */
export async function replies(
  ctx: SlackCtx,
  input: { channel: string; ts: string },
): Promise<SlackMessageRow[]> {
  const args = { channel: input.channel, ts: input.ts, limit: 200 };
  const out = await call<Awaited<ReturnType<SlackApi["replies"]>>>(
    ctx,
    "conversations.replies",
    args,
    (s) => s.replies(args),
    () => ({ ok: true as const, messages: [] }),
  );
  return (out.messages ?? []) as SlackMessageRow[];
}

export async function userInfo(
  ctx: SlackCtx,
  user: string,
): Promise<{ id: string; name: string; email?: string }> {
  const out = await call<Awaited<ReturnType<SlackApi["userInfo"]>>>(
    ctx,
    "users.info",
    { user },
    (s) => s.userInfo({ user }),
    () => ({ ok: true as const, user: { id: user, name: user } }),
  );
  const u = out.user;
  if (!u) return { id: user, name: user };
  const name =
    u.profile?.display_name ||
    u.profile?.real_name ||
    u.real_name ||
    u.name ||
    user;
  return { id: u.id, name, email: u.profile?.email };
}

/** A link to a message. Slack redirects `slack.com/archives` to the viewer's workspace. */
export function permalink(
  channel: string,
  ts: string,
  threadTs?: string,
): string {
  const base = `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts
    ? `${base}?thread_ts=${threadTs}&cid=${channel}`
    : base;
}

/**
 * Swap the clicked card's buttons for a "working" line (see `workingCard`). Best effort: the click
 * is handled either way, and a failed placeholder must not fail it.
 */
export async function showWorking(
  ctx: SlackCtx & {
    logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  },
  click: {
    user: { id: string };
    container?: { channel_id?: string; message_ts?: string };
    message?: { text?: string; blocks?: Block[] };
    actions: { block_id?: string }[];
  },
  verb: string,
  build: (
    blocks: readonly Block[] | undefined,
    blockId: string | undefined,
    verb: string,
    userId: string,
  ) => Block[] | null,
): Promise<void> {
  const channel = click.container?.channel_id;
  const ts = click.container?.message_ts;
  const blocks = build(
    click.message?.blocks,
    click.actions[0]?.block_id,
    verb,
    click.user.id,
  );
  if (!channel || !ts || !blocks) return;
  try {
    await update(ctx, { channel, ts, text: click.message?.text, blocks });
  } catch (err) {
    ctx.logger?.warn("working card not shown; handling the click anyway", {
      err: String(err),
    });
  }
}

/**
 * Put the clicked message back as Slack sent it, for a click that ends after `showWorking` without
 * a card of its own to draw. Best effort, like the placeholder it undoes.
 */
export async function restoreClicked(
  ctx: SlackCtx & {
    logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  },
  click: {
    container?: { channel_id?: string; message_ts?: string };
    message?: { text?: string; blocks?: Block[] };
  },
): Promise<void> {
  const channel = click.container?.channel_id;
  const ts = click.container?.message_ts;
  const blocks = click.message?.blocks;
  if (!channel || !ts || !blocks?.length) return;
  try {
    await update(ctx, { channel, ts, text: click.message?.text, blocks });
  } catch (err) {
    ctx.logger?.warn("clicked card not restored", { err: String(err) });
  }
}
