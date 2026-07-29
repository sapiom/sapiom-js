import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { createFetch } from "@sapiom/fetch";

/**
 * Slack Notifier — the "bring your own API" teaching template.
 *
 * The lesson: declare *your own* credential, then call an
 * external API with it at runtime. The concrete hook is Slack ("post a message
 * to my channel"), but the shape is transferable — swap the endpoint and the
 * secret key and you can call any API you can reach with a token.
 *
 * Slack has no Sapiom capability namespace, so the deployed agent uses a
 * credential the platform injects into the step's environment — never baked
 * into code. Bot mode uses metered `@sapiom/fetch`; webhook mode deliberately
 * uses native fetch because the secret is embedded in the URL path. Two modes:
 *
 *   - `bot` (default) — a bot token calls `chat.postMessage`; returns the
 *     resolved channel id + message `ts` (timestamp).
 *   - `webhook` — an incoming-webhook URL; the channel is baked into the URL,
 *     so there is no `ts` to return.
 *
 * SAFETY / onboarding: with no credential set, the run composes the message,
 * reports `posted: false, skipped: "no-credential"`, and reaches a terminal
 * state — so you can trace the graph before you have a token, and nothing ever
 * claims a message was delivered when it was not. A real `deploy` + `run` with a
 * token posts to Slack for real.
 *
 * Where the key lives: the credentials declared in `template.json`
 * (`SLACK_BOT_TOKEN`, `SLACK_WEBHOOK_URL`) are collected when you use this
 * template and arrive as `process.env` on the step. The template declares what
 * the credential IS; where it is stored is the platform's business. See
 * README.md for how to generalize this to any API.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Env key for a bot token (used by the `bot` auth mode). */
const BOT_TOKEN_KEY = "SLACK_BOT_TOKEN";
/** Env key for an incoming-webhook URL (used by the `webhook` auth mode). */
const WEBHOOK_KEY = "SLACK_WEBHOOK_URL";
/** Slack's per-message text limit. Oversized messages are rejected, not sent. */
const MAX_MESSAGE_LENGTH = 4000;
/**
 * What a zero-input run posts. A default message is what lets the template reach
 * its own no-credential guard instead of self-rejecting before it gets there.
 */
const DEFAULT_MESSAGE =
  "Hello from Sapiom — this message was composed by the slack-notifier template.";

type AuthMode = "bot" | "webhook";

interface EntryInput {
  /** The message text to post. Defaults to a fixed hello so `{}` runs. */
  message?: string;
  /**
   * Target channel for the `bot` mode — a name (`#general`) or id (`C0123`).
   * Ignored by `webhook` mode, where the channel is baked into the URL.
   */
  channel?: string;
  /** Which credential to use. Defaults to `bot`. */
  via?: AuthMode;
  /** Optional formatting hint: override the bot's display name for this post. */
  username?: string;
  /**
   * Skip the real Slack call (network I/O). Nothing sets this for you — pass it
   * explicitly (`run_local` with `{ "dryRun": true }`) when you want the graph
   * traced without a post attempt.
   */
  dryRun?: boolean;
}

interface PostResult extends Record<string, unknown> {
  posted: boolean;
  /** Why we didn't post, when `posted` is false (dryRun, no-credential, …). */
  skipped: string | null;
  via: AuthMode;
  channel: string | null;
  /** Slack message timestamp (`bot` mode only); null otherwise. */
  ts: string | null;
  /** Credential keys the run needed and did not have. Empty when it posted. */
  unmet?: string[];
  /** One plain sentence about what did or did not reach Slack. */
  note?: string;
}

interface Shared extends Record<string, unknown> {
  dryRun: boolean;
  via: AuthMode;
  channel: string | null;
  message: string;
  username: string | null;
}

type Ctx = AgentExecutionContext<Shared>;

// ────────────────────────────────────────────────────────────── helpers ──

/**
 * Post to Slack via `chat.postMessage` with a bot token. Slack's Web API is
 * form-encoded and signals errors in the JSON body (`{ ok: false, error }`),
 * not the HTTP status, so we check `ok` explicitly.
 */
export async function postViaBot(
  meteredFetch: typeof fetch,
  token: string,
  channel: string,
  text: string,
  username: string | null,
): Promise<{ channel: string | null; ts: string | null }> {
  const form = new URLSearchParams({
    channel,
    text,
    unfurl_links: "false",
    unfurl_media: "false",
  });
  if (username) form.set("username", username);
  const res = await meteredFetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!json.ok) {
    throw new Error(`slack chat.postMessage failed: ${String(json.error)}`);
  }
  return {
    channel: (json.channel as string) ?? channel,
    ts: (json.ts as string) ?? null,
  };
}

/**
 * Post to Slack via an incoming-webhook URL. The channel is fixed by the URL,
 * so there is no channel/ts to return. A webhook answers `ok` (plain text), not
 * JSON, so we check the HTTP status.
 */
export async function postViaWebhook(
  url: string,
  text: string,
  username: string | null,
): Promise<void> {
  const body: Record<string, unknown> = { text };
  if (username) body.username = username;
  // An incoming-webhook URL is itself a bearer credential. Do not pass it
  // through @sapiom/fetch, whose request facts include the complete URL.
  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`slack webhook failed: ${res.status} ${detail}`);
  }
}

// ──────────────────────────────────────────────────────────────── steps ──

/** Validate inputs and resolve config before any network call. */
const validate = defineStep({
  name: "validate",
  next: ["post", "rejected"],
  async run(input: EntryInput, ctx: Ctx) {
    const dryRun = input?.dryRun === true;
    const via: AuthMode = input?.via === "webhook" ? "webhook" : "bot";
    const message = (input?.message ?? "").trim() || DEFAULT_MESSAGE;
    const channel = (input?.channel ?? "").trim() || null;
    const username = (input?.username ?? "").trim() || null;

    if (message.length > MAX_MESSAGE_LENGTH) {
      return goto("rejected", {
        reason: `message length ${message.length} exceeds cap ${MAX_MESSAGE_LENGTH}`,
      });
    }
    // The channel is only required once we actually have a token to post with, so
    // `post` checks it after the credential. Rejecting here would stop a
    // no-credential run before it reached the guard that explains itself.

    ctx.shared.set("dryRun", dryRun);
    ctx.shared.set("via", via);
    ctx.shared.set("channel", channel);
    ctx.shared.set("message", message);
    ctx.shared.set("username", username);

    ctx.logger.info("validated slack post", { via, channel, dryRun });
    return goto("post", {});
  },
});

/** Read the injected credential and post to Slack. */
const post = defineStep({
  name: "post",
  next: ["posted", "failed", "rejected"],
  async run(_input: unknown, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") ?? false;
    const via = ctx.shared.get("via") ?? "bot";
    const channel = ctx.shared.get("channel") ?? null;
    const message = ctx.shared.get("message")!;
    const username = ctx.shared.get("username") ?? null;

    // Explicit dryRun: skip the network so the full graph runs offline for free.
    if (dryRun) {
      ctx.logger.info("dryRun — skipping Slack post", { via, channel });
      return goto("posted", {
        posted: false,
        skipped: "dryRun",
        via,
        channel,
        ts: null,
        unmet: [],
        note: "`dryRun` was set, so nothing was posted. The message above is what would have been sent.",
      } satisfies PostResult);
    }

    // Read the credential from the environment the platform injected it into —
    // never baked into code, and never a store name the template has to know.
    const secretKey = via === "webhook" ? WEBHOOK_KEY : BOT_TOKEN_KEY;
    const secret = process.env[secretKey]?.trim() || null;

    // No-key guard: compose but don't post, and say so. Posting is the entire
    // point of this template, so a missing token can only ever mean "skip" —
    // reporting `posted: true` with no token would be a lie about the outside world.
    if (!secret) {
      ctx.logger.warn("no slack credential set — skipping post", {
        key: secretKey,
      });
      return goto("posted", {
        posted: false,
        skipped: "no-credential",
        via,
        channel,
        ts: null,
        unmet: [secretKey],
        note: `No \`${secretKey}\` is set, so nothing was posted to Slack. The message above is what would have been sent — add the credential and re-run to post it.`,
      } satisfies PostResult);
    }

    // With a token in hand, bot mode does need a channel; webhook mode has it in
    // the URL.
    if (via === "bot" && !channel) {
      return goto("rejected", {
        reason:
          "channel is required for `bot` mode (e.g. '#general' or 'C0123')",
      });
    }

    try {
      if (via === "webhook") {
        await postViaWebhook(secret, message, username);
        ctx.logger.info("posted to slack via webhook");
        return goto("posted", {
          posted: true,
          skipped: null,
          via,
          channel: null,
          ts: null,
        } satisfies PostResult);
      }

      // Live workflow steps receive SAPIOM_API_KEY as their principal
      // credential. Bot mode fails closed if Core cannot authorize and
      // attribute the external request to this execution.
      const meteredFetch = createFetch({
        apiKey: process.env.SAPIOM_API_KEY,
        agentName: "slack-notifier",
        serviceName: "slack",
        traceExternalId: ctx.executionId,
        failureMode: "closed",
      });
      const resolved = await postViaBot(
        meteredFetch,
        secret,
        channel!,
        message,
        username,
      );
      ctx.logger.info("posted to slack via bot token", resolved);
      return goto("posted", {
        posted: true,
        skipped: null,
        via,
        channel: resolved.channel,
        ts: resolved.ts,
      } satisfies PostResult);
    } catch (err) {
      ctx.logger.error("slack post failed", { err: String(err) });
      return goto("failed", { error: String(err) });
    }
  },
});

const posted = defineStep({
  name: "posted",
  next: [],
  terminal: true,
  async run(input: PostResult) {
    return terminate(input);
  },
});

const failed = defineStep({
  name: "failed",
  next: [],
  terminal: true,
  async run(input: { error: string }) {
    return terminate({
      posted: false,
      failed: true,
      error: input?.error ?? "unknown error",
    });
  },
});

const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { reason: string }) {
    return terminate({
      posted: false,
      rejected: true,
      reason: input?.reason ?? "rejected",
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "slack-notifier",
  entry: "validate",
  steps: { validate, post, posted, failed, rejected },
});
