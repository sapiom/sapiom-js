/**
 * Slack, through the tenant's Slack connector: `POST {tools}/connectors/v1/slack/methods/<name>`
 * on the run's credential. The bot token never enters the run. `@sapiom/tools` has no Slack
 * wrapper, so this is a thin fetch.
 *
 * On a local trace nothing is sent: each call logs and returns a plausible stub, so `run_local`
 * walks the real step code without posting to Slack.
 */
import type { AgentExecutionContext } from "@sapiom/agent";

export type SlackCtx = Pick<
  AgentExecutionContext<Record<string, unknown>>,
  "isLocalTrace" | "logger"
>;

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

function toolsBase(): string {
  return (process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai").replace(
    /\/+$/,
    "",
  );
}

/** Live agent steps receive their run credential as `SAPIOM_API_KEY`. */
function runCredential(): string {
  const key = process.env.SAPIOM_API_KEY;
  if (!key)
    throw new Error(
      "SAPIOM_API_KEY is not set; Slack connector methods need the run credential",
    );
  return key;
}

let localTs = 1_790_000_000;
const stubTs = () => `${++localTs}.000100`;

/** Call one connector method. Arg names are the connector's, which are not always Slack's. */
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
  const res = await fetch(
    `${toolsBase()}/connectors/v1/slack/methods/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sapiom-api-key": runCredential(),
      },
      body: JSON.stringify(args),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // not JSON; keep the raw prefix
    }
    throw new SlackMethodError(method, res.status, detail);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function post(
  ctx: SlackCtx,
  input: {
    channel: string;
    text?: string;
    blocks?: Block[];
    threadTs?: string;
  },
): Promise<{ channel: string; ts: string }> {
  const out = await callSlack<{ channel: string | null; ts: string | null }>(
    ctx,
    "chat.postMessage",
    {
      channel: input.channel,
      text: input.text,
      blocks: input.blocks,
      threadTs: input.threadTs,
    },
    () => ({ channel: input.channel, ts: stubTs() }),
  );
  if (!out.ts)
    throw new SlackMethodError("chat.postMessage", 200, "no ts in response");
  return { channel: out.channel ?? input.channel, ts: out.ts };
}

export async function update(
  ctx: SlackCtx,
  input: { channel: string; ts: string; text?: string; blocks?: Block[] },
): Promise<void> {
  await callSlack(
    ctx,
    "chat.update",
    {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: input.blocks,
    },
    () => ({
      ok: true,
    }),
  );
}

/** Visible only to `user`. The connector takes `thread_ts` here, not `threadTs`. */
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
  await callSlack(
    ctx,
    "chat.postEphemeral",
    {
      channel: input.channel,
      user: input.user,
      text: input.text,
      blocks: input.blocks,
      thread_ts: input.threadTs,
    },
    () => ({ ok: true }),
  );
}

async function reaction(
  ctx: SlackCtx,
  method: "reactions.add" | "reactions.remove",
  input: { channel: string; ts: string; name: string },
) {
  try {
    await callSlack(
      ctx,
      method,
      { channel: input.channel, timestamp: input.ts, name: input.name },
      () => ({ ok: true }),
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
  const out = await callSlack<{ messages?: SlackMessageRow[] }>(
    ctx,
    "conversations.replies",
    { channel: input.channel, ts: input.ts, limit: 200 },
    () => ({ messages: [] }),
  );
  return out.messages ?? [];
}

export async function userInfo(
  ctx: SlackCtx,
  user: string,
): Promise<{ id: string; name: string; email?: string }> {
  const out = await callSlack<{
    user?: {
      id: string;
      name?: string;
      real_name?: string;
      profile?: { display_name?: string; real_name?: string; email?: string };
    };
  }>(ctx, "users.info", { user }, () => ({ user: { id: user, name: user } }));
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
