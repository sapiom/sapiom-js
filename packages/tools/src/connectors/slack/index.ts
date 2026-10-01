/**
 * `slack` capability — tenant-scoped Slack Web API methods executed server-side in the
 * connectors gateway. The args are POSTed to the gateway's method route on the run
 * credential (`x-sapiom-api-key`); the gateway resolves the tenant's Slack bot token
 * INTERNALLY and calls Slack — the token NEVER crosses this boundary, only the result
 * comes back.
 *
 *   import { connectors } from "@sapiom/tools";
 *   const { ts } = await connectors.slack.postMessage({ channel, text: "On it." });
 *
 * Or on the step context: `ctx.sapiom.connectors.slack.postMessage(...)`.
 *
 * Wire: `POST ${baseUrl}/connectors/v1/slack/methods/<slack method>`, e.g.
 * `chat.postMessage`, body = the args under the gateway's arg names. The SDK names are
 * camelCase; the two places the gateway's names differ from the SDK's
 * (`chat.postEphemeral`'s `thread_ts`) are mapped here. The gateway returns
 * `chat.postMessage` as `{ ok, channel, ts }` and every other method as Slack's own
 * response body. Non-2xx throws (Transport.request), carrying the gateway body:
 * 404 connector_not_found (connect Slack first), 400 connector_method_invalid_args,
 * 403 when the install lacks a scope the method needs, 502 connector_method_upstream_failed
 * (Slack answered `ok: false`; its error code is in the message).
 */
import { Transport, defaultTransport } from "../../_client/index.js";

// Same tools host agents/models resolve — via SAPIOM_TOOLS_BASE. No new per-cap config.
const DEFAULT_BASE_URL =
  process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai";

/** A Block Kit block, passed through to Slack untouched. */
export type SlackBlock = Record<string, unknown>;

/** Message contents: give `text`, `blocks`, or both (the gateway 400s when neither is set). */
export interface SlackMessageContent {
  text?: string;
  blocks?: SlackBlock[];
}

export interface SlackPostMessageArgs extends SlackMessageContent {
  /** Channel id, or a user id to DM. */
  channel: string;
  /** Parent message `ts` to reply in its thread. */
  threadTs?: string;
}

export interface SlackPostMessageResult {
  ok: true;
  channel: string | null;
  ts: string | null;
}

export interface SlackUpdateArgs extends SlackMessageContent {
  channel: string;
  /** `ts` of the message to edit. */
  ts: string;
}

export interface SlackUpdateResult {
  ok: true;
  channel: string;
  ts: string;
  text?: string;
  message?: SlackMessage;
  [key: string]: unknown;
}

export interface SlackPostEphemeralArgs extends SlackMessageContent {
  channel: string;
  /** The user who sees the message. */
  user: string;
  /** Parent message `ts` to show it in that thread. */
  threadTs?: string;
}

export interface SlackPostEphemeralResult {
  ok: true;
  message_ts: string;
  [key: string]: unknown;
}

export interface SlackReactionArgs {
  channel: string;
  /** `ts` of the message to react to. */
  timestamp: string;
  /** Emoji name, without colons (e.g. `"eyes"`). */
  name: string;
}

export interface SlackReactionResult {
  ok: true;
  [key: string]: unknown;
}

export interface SlackRepliesArgs {
  channel: string;
  /** `ts` of the thread's parent message. */
  ts: string;
  /** `response_metadata.next_cursor` from a previous page. */
  cursor?: string;
  /** Messages per page, 1-1000. */
  limit?: number;
}

/** A Slack message as the Web API returns it; fields beyond these pass through. */
export interface SlackMessage {
  type?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  blocks?: SlackBlock[];
  [key: string]: unknown;
}

export interface SlackRepliesResult {
  ok: true;
  /** The parent message first, then its replies. */
  messages: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
  [key: string]: unknown;
}

export interface SlackUserInfoArgs {
  user: string;
}

/** A Slack user as `users.info` returns it; fields beyond these pass through. */
export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  tz?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    image_72?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SlackUserInfoResult {
  ok: true;
  user: SlackUser;
  [key: string]: unknown;
}

function callMethod<T>(
  method: string,
  body: Record<string, unknown>,
  transport: Transport,
): Promise<T> {
  return transport.request<T>(
    `${DEFAULT_BASE_URL}/connectors/v1/slack/methods/${method}`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Post a message, optionally as a thread reply (`threadTs`). */
export async function postMessage(
  args: SlackPostMessageArgs,
  transport: Transport = defaultTransport(),
): Promise<SlackPostMessageResult> {
  return callMethod("chat.postMessage", { ...args }, transport);
}

/** Edit a message the bot posted. */
export async function update(
  args: SlackUpdateArgs,
  transport: Transport = defaultTransport(),
): Promise<SlackUpdateResult> {
  return callMethod("chat.update", { ...args }, transport);
}

/** Post a message only `user` can see. */
export async function postEphemeral(
  args: SlackPostEphemeralArgs,
  transport: Transport = defaultTransport(),
): Promise<SlackPostEphemeralResult> {
  const { threadTs, ...rest } = args;
  // The gateway reads this method's thread under Slack's own name.
  const body = threadTs === undefined ? rest : { ...rest, thread_ts: threadTs };
  return callMethod("chat.postEphemeral", body, transport);
}

/** Add an emoji reaction to a message. */
export async function addReaction(
  args: SlackReactionArgs,
  transport: Transport = defaultTransport(),
): Promise<SlackReactionResult> {
  return callMethod("reactions.add", { ...args }, transport);
}

/** Remove an emoji reaction the bot added. */
export async function removeReaction(
  args: SlackReactionArgs,
  transport: Transport = defaultTransport(),
): Promise<SlackReactionResult> {
  return callMethod("reactions.remove", { ...args }, transport);
}

/** Read a thread: the parent message and its replies, one page at a time. */
export async function replies(
  args: SlackRepliesArgs,
  transport: Transport = defaultTransport(),
): Promise<SlackRepliesResult> {
  return callMethod("conversations.replies", { ...args }, transport);
}

/** Look up a user by id (name, display name, timezone, bot flag). */
export async function userInfo(
  args: SlackUserInfoArgs,
  transport: Transport = defaultTransport(),
): Promise<SlackUserInfoResult> {
  return callMethod("users.info", { ...args }, transport);
}
