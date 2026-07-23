import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Slack Notifier — the "bring your own API" teaching template.
 *
 * The lesson: store *your own* credential in the Sapiom Vault, then call an
 * external API with it at runtime. The concrete hook is Slack ("post a message
 * to my channel"), but the shape is transferable — swap the endpoint and the
 * secret key and you can call any API you can reach with a token.
 *
 * Slack has no Sapiom capability namespace, so the deployed agent calls the
 * Slack API directly via `fetch`, using a credential read from the Vault
 * (`ctx.sapiom.vault.get(ref, key)`) — never baked into code. Two auth modes:
 *
 *   - `bot` (default) — a bot token calls `chat.postMessage`; returns the
 *     resolved channel id + message `ts` (timestamp).
 *   - `webhook` — an incoming-webhook URL; the channel is baked into the URL,
 *     so there is no `ts` to return.
 *
 * SAFETY / onboarding: `dryRun` (set by `run_local`) exercises the full control
 * flow — validate → post — without touching the network. A missing credential
 * is treated the same way (a "no-key guard"), so you can trace the graph before
 * you have set a token. A real `deploy` + `run` posts to Slack for real.
 *
 * Where the key lives: after you deploy, set your token in the Vault under the
 * ref `slack` (key `bot_token` or `webhook_url`) — scoped to this workflow. See
 * README.md for the exact command and how to generalize this to any API.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Vault ref that holds this workflow's Slack credential. */
const VAULT_REF = "slack";
/** Vault key for a bot token (used by the `bot` auth mode). */
const BOT_TOKEN_KEY = "bot_token";
/** Vault key for an incoming-webhook URL (used by the `webhook` auth mode). */
const WEBHOOK_KEY = "webhook_url";
/** Slack's per-message text limit. Oversized messages are rejected, not sent. */
const MAX_MESSAGE_LENGTH = 4000;

type AuthMode = "bot" | "webhook";

interface EntryInput {
  /** The message text to post. Required (unless `dryRun`, which uses a stub). */
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
  /** Skip the real Slack call (network I/O). Set by `run_local`. */
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
async function postViaBot(
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
  const res = await fetch("https://slack.com/api/chat.postMessage", {
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
async function postViaWebhook(
  url: string,
  text: string,
  username: string | null,
): Promise<void> {
  const body: Record<string, unknown> = { text };
  if (username) body.username = username;
  const res = await fetch(url, {
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
    const message = (input?.message ?? "").trim();
    const channel = (input?.channel ?? "").trim() || null;
    const username = (input?.username ?? "").trim() || null;

    if (!message) {
      return goto("rejected", { reason: "message is required" });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return goto("rejected", {
        reason: `message length ${message.length} exceeds cap ${MAX_MESSAGE_LENGTH}`,
      });
    }
    // Bot mode needs a channel; webhook mode carries it in the URL.
    if (via === "bot" && !channel && !dryRun) {
      return goto("rejected", {
        reason:
          "channel is required for `bot` mode (e.g. '#general' or 'C0123')",
      });
    }

    ctx.shared.set("dryRun", dryRun);
    ctx.shared.set("via", via);
    ctx.shared.set("channel", channel);
    ctx.shared.set("message", message);
    ctx.shared.set("username", username);

    ctx.logger.info("validated slack post", { via, channel, dryRun });
    return goto("post", {});
  },
});

/** Read the credential from the Vault and post to Slack. */
const post = defineStep({
  name: "post",
  next: ["posted", "failed"],
  async run(_input: unknown, ctx: Ctx) {
    const dryRun = ctx.shared.get("dryRun") ?? false;
    const via = ctx.shared.get("via") ?? "bot";
    const channel = ctx.shared.get("channel") ?? null;
    const message = ctx.shared.get("message")!;
    const username = ctx.shared.get("username") ?? null;

    // dryRun (run_local): skip the network, synthesize a plausible result so the
    // full graph runs offline for free.
    if (dryRun) {
      ctx.logger.info("dryRun — skipping Slack post", { via, channel });
      return goto("posted", {
        posted: false,
        skipped: "dryRun",
        via,
        channel,
        ts: null,
      } satisfies PostResult);
    }

    // Read the credential at runtime — never baked into code.
    const secretKey = via === "webhook" ? WEBHOOK_KEY : BOT_TOKEN_KEY;
    let secret: string | null = null;
    try {
      secret = await ctx.sapiom.vault.get(VAULT_REF, secretKey);
    } catch (err) {
      ctx.logger.warn("vault: no slack credential", { err: String(err) });
    }
    // No-key guard: behave like dryRun so a fresh fork traces end to end before
    // you have set a token.
    if (!secret) {
      ctx.logger.warn("no slack credential in vault — skipping post", {
        ref: VAULT_REF,
        key: secretKey,
      });
      return goto("posted", {
        posted: false,
        skipped: "no-credential",
        via,
        channel,
        ts: null,
      } satisfies PostResult);
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
      const resolved = await postViaBot(secret, channel!, message, username);
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
