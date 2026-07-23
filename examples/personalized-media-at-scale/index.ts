import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { VIDEO_RESULT_SIGNAL, type VideoResultPayload } from "@sapiom/tools";
import postgres from "postgres";

/**
 * Personalized Media at Scale — one custom image or short clip per row, stored
 * and emailed.
 *
 * A marketer keeps a table of leads or customers, each with a bit of context.
 * On a schedule this reads that table and, per row, generates a personalized
 * asset — an image (`contentGeneration.images`) or a short clip
 * (`contentGeneration.video`) — persists it, and emails the recipient a link.
 *
 * The graph forks on the chosen medium:
 *
 *   fetch ─▶ renderImages ─────────────────▶ deliver
 *   (db)  └▶ renderClip ⇄ collectClip ──────▶ deliver
 *            (video.launch)   (drain)          (email)
 *
 *   1. fetch — read up to `limit` recipient rows from a Postgres table
 *      (`ctx.sapiom.database`), creating and seeding it on first run so the
 *      template works out of the box. `dryRun` stops here and returns the rows
 *      plus the prompt each would get, with nothing generated or sent.
 *   2a. renderImages (image medium) — fan out one personalized image per row,
 *       all at once (sync), each persisted for a durable `fileId`.
 *   2b. renderClip ⇄ collectClip (video medium) — one row at a time, launch an
 *       async text-to-video job and `pauseUntilSignal` on it; the FAL webhook
 *       resumes `collectClip`, which records the clip and loops back for the
 *       next row or advances once every row is done.
 *   3. deliver — email each recipient a link to their own asset.
 *
 * Why sequential clips rather than launching every video at once: a paused step
 * waits on a single `(signal, correlationId)` pair, so launching shot i only
 * after shot i-1 has resumed keeps a paused step always waiting before its job
 * can complete (the `scene-to-video` lesson).
 *
 * Images are the cheaper default. Video is async and pricier — keep `limit`
 * small while you try it.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Default database handle; the table lives inside it. */
const DEFAULT_DB_HANDLE = "personalized-media";
/** Table holding the recipient rows this agent renders media for. */
const TABLE = "media_recipients";
/** How many rows to render per run by default (kept small — each row bills). */
const DEFAULT_LIMIT = 3;
/** Hard cap on rows per run so a big table can't fan out into a huge bill. */
const MAX_LIMIT = 25;
/** Default cadence when the caller doesn't pass one: 09:00 every day. */
const DEFAULT_SCHEDULE = "0 9 * * *";
/** Default async text-to-video model alias (resolved server-side). */
const DEFAULT_VIDEO_MODEL = "veo3-fast";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "personalized-media";

// ─────────────────────────────────────────────────────────────── shapes ──
type Medium = "image" | "video";

/** Trigger input. Everything is optional — it runs on seeded demo rows as-is. */
interface EntryInput {
  /** Database handle holding the recipient table. */
  dbHandle?: string;
  /** "image" (default, sync, cheaper) or "video" (async, pricier). */
  medium?: Medium;
  /** Cron cadence this batch is meant to run on (e.g. "0 9 * * *"). */
  schedule?: string;
  /** How many rows to render this run (default 3, clamped 1–25). */
  limit?: number;
  /** A creative direction folded into every prompt (e.g. "warm, editorial"). */
  style?: string;
  /** Aspect ratio for generated video (default "16:9"); images use the model default. */
  aspectRatio?: string;
  /** Video model alias or raw id, passed through to `video.launch`. */
  videoModel?: string;
  /** Plan only — read the rows and prompts, generate and send nothing. */
  dryRun?: boolean;
}

/** One recipient row, as stored in the table and carried through the run. */
interface Recipient {
  id: number;
  name: string;
  email: string;
  /** Personalization hint the prompt is built from (interests, locale, etc.). */
  context: string;
}

/** A rendered, persisted asset tied back to its recipient. */
interface Asset {
  recipientId: number;
  name: string;
  email: string;
  medium: Medium;
  fileId: string | null;
  downloadUrl: string | null;
}

interface Shared extends Record<string, unknown> {
  dbHandle: string;
  medium: Medium;
  schedule: string;
  style: string;
  aspectRatio: string;
  videoModel: string;
  rows: Recipient[];
  assets: Asset[];
  /** Index of the next row to animate; advanced by `collectClip`. */
  clipIndex: number;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
}

/**
 * Build the personalized generation prompt for a row. Deterministic on purpose —
 * this template generates media, not copy, so no LLM is in the loop. Swap in
 * `ctx.sapiom.models.run` here if you want the prompt itself written per row.
 */
function buildPrompt(row: Recipient, medium: Medium, style: string): string {
  const look = style.trim() || "clean, modern, brand-friendly";
  const base = `A personalized ${medium === "video" ? "short promotional clip" : "marketing image"} for ${row.name}. Theme: ${row.context}. Style: ${look}. No text, no watermark.`;
  return medium === "video"
    ? `${base} Gentle camera motion; a single continuous shot.`
    : base;
}

/**
 * Open a Postgres client (creating the database if absent), or null when no
 * connection string is available — e.g. under stubbed capabilities in
 * `run_local`. Mirrors `the-brain`'s create-if-missing seam. Reading rows is
 * free, so this runs on a dry run too; only generation + email are gated.
 */
async function openSql(
  ctx: Ctx,
  handle: string,
): Promise<ReturnType<typeof postgres> | null> {
  let db;
  try {
    db = await ctx.sapiom.database.get(handle);
  } catch {
    db = await ctx.sapiom.database.create({
      handle,
      duration: "7d",
      name: "Personalized Media",
      description: "Recipient rows for the personalized-media-at-scale agent",
    });
  }
  const conn = db?.connection?.connectionString ?? null;
  if (!conn) {
    ctx.logger.warn("database: no connection string", { handle });
    return null;
  }
  return postgres(conn, { ssl: "require" });
}

/** Create the recipient table and seed a few demo rows the first time only. */
async function ensureSeeded(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    create table if not exists ${sql(TABLE)} (
      id         bigserial primary key,
      name       text not null,
      email      text not null,
      context    text not null default '',
      created_at timestamptz not null default now()
    )`;
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(TABLE)}`;
  if (count > 0) return;
  await sql`
    insert into ${sql(TABLE)} ${sql(
      [
        {
          name: "Ada Lovelace",
          email: "ada@example.com",
          context: "loves vintage computing and long-distance cycling",
        },
        {
          name: "Grace Hopper",
          email: "grace@example.com",
          context: "sailing weekends, precise minimalist aesthetic",
        },
        {
          name: "Alan Turing",
          email: "alan@example.com",
          context: "morning runs, chess, quiet English countryside",
        },
      ],
      "name",
      "email",
      "context",
    )}`;
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "Personalized Media",
  });
  return inbox.inboxId;
}

// ─────────────────────────────────────────────────────────────── steps ──
const fetch = defineStep({
  name: "fetch",
  next: ["renderImages", "renderClip"],
  terminal: true,
  async run(input: EntryInput, ctx: Ctx) {
    const dbHandle = input.dbHandle?.trim() || DEFAULT_DB_HANDLE;
    const medium: Medium = input.medium === "video" ? "video" : "image";
    const dryRun = input.dryRun === true;
    const style = input.style?.trim() ?? "";
    const aspectRatio = input.aspectRatio?.trim() || "16:9";
    const videoModel = input.videoModel?.trim() || DEFAULT_VIDEO_MODEL;
    const limit = clampLimit(input.limit);

    ctx.shared.set("dbHandle", dbHandle);
    ctx.shared.set("medium", medium);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("style", style);
    ctx.shared.set("aspectRatio", aspectRatio);
    ctx.shared.set("videoModel", videoModel);
    ctx.shared.set("assets", []);
    ctx.shared.set("clipIndex", 0);

    // Read the recipient rows (free — runs on a dry run too). Under stubbed
    // capabilities in run_local there's no connection string, so `rows` stays
    // empty and the graph still traces end to end.
    const sql = await openSql(ctx, dbHandle);
    let rows: Recipient[] = [];
    if (sql) {
      try {
        await ensureSeeded(sql);
        rows = await sql<Recipient[]>`
          select id, name, email, context
          from ${sql(TABLE)}
          order by id asc
          limit ${limit}`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    ctx.shared.set("rows", rows);
    ctx.logger.info("fetched recipients", { rows: rows.length, medium });

    if (dryRun) {
      ctx.logger.info("dryRun — returning plan only");
      return terminate({
        dryRun: true,
        medium,
        planned: rows.map((r) => ({
          recipientId: r.id,
          name: r.name,
          email: r.email,
          prompt: buildPrompt(r, medium, style),
        })),
      });
    }
    if (rows.length === 0) {
      // No rows to render — end cleanly rather than fanning out over nothing.
      return terminate({ medium, rendered: 0, delivered: 0, assets: [] });
    }
    return goto(medium === "video" ? "renderClip" : "renderImages", {});
  },
});

const renderImages = defineStep({
  name: "renderImages",
  next: ["deliver"],
  async run(_input: unknown, ctx: Ctx) {
    const rows = must(ctx.shared.get("rows"), "rows");
    const style = ctx.shared.get("style") ?? "";
    ctx.logger.info("generating images", { rows: rows.length });

    // Fan-out: one personalized image per row, generated concurrently. `storage`
    // persists each output so we get a durable `fileId` + a ready-to-use link.
    const generated = await Promise.all(
      rows.map((row) =>
        ctx.sapiom.contentGeneration.images.create({
          prompt: buildPrompt(row, "image", style),
          numImages: 1,
          storage: { visibility: "private" },
        }),
      ),
    );
    const assets: Asset[] = generated.map((result, i) => {
      const row = rows[i];
      const img = result.images?.[0];
      return {
        recipientId: row.id,
        name: row.name,
        email: row.email,
        medium: "image",
        fileId: img?.fileId ?? null,
        downloadUrl: img?.downloadUrl ?? img?.url ?? null,
      };
    });
    ctx.shared.set("assets", assets);
    ctx.logger.info("images ready", { count: assets.length });
    return goto("deliver", { assets });
  },
});

const renderClip = defineStep({
  name: "renderClip",
  next: [],
  // Async pause/resume: the launched video job fires VIDEO_RESULT_SIGNAL on
  // completion (the FAL webhook), resuming `collectClip` with the clip's result.
  pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "collectClip" },
  async run(_input: unknown, ctx: Ctx) {
    const rows = must(ctx.shared.get("rows"), "rows");
    const style = ctx.shared.get("style") ?? "";
    const index = must(ctx.shared.get("clipIndex"), "clipIndex");
    const row = rows[index];

    ctx.logger.info("rendering clip", { index: index + 1, of: rows.length });
    const handle = await ctx.sapiom.contentGeneration.video.launch({
      model: must(ctx.shared.get("videoModel"), "videoModel"),
      prompt: buildPrompt(row, "video", style),
      params: {
        aspect_ratio: must(ctx.shared.get("aspectRatio"), "aspectRatio"),
      },
      storage: { visibility: "private" },
    });
    return await pauseUntilSignal(handle, { resumeStep: "collectClip" });
  },
});

const collectClip = defineStep({
  name: "collectClip",
  next: ["renderClip", "deliver"],
  async run(result: VideoResultPayload, ctx: Ctx) {
    const rows = must(ctx.shared.get("rows"), "rows");
    const assets = must(ctx.shared.get("assets"), "assets");
    const index = must(ctx.shared.get("clipIndex"), "clipIndex");
    const row = rows[index];

    const out = result.outputs?.[0];
    const asset: Asset = {
      recipientId: row.id,
      name: row.name,
      email: row.email,
      medium: "video",
      fileId: out?.fileId ?? null,
      downloadUrl: out?.downloadUrl ?? null,
    };
    const nextAssets = [...assets, asset];
    const nextIndex = index + 1;
    ctx.shared.set("assets", nextAssets);
    ctx.shared.set("clipIndex", nextIndex);
    ctx.logger.info("collected clip", {
      collected: nextAssets.length,
      of: rows.length,
    });

    // More rows to render? Loop back. Otherwise every clip is in — deliver them.
    return nextIndex < rows.length
      ? goto("renderClip", {})
      : goto("deliver", { assets: nextAssets });
  },
});

const deliver = defineStep({
  name: "deliver",
  next: [],
  terminal: true,
  async run(input: { assets?: Asset[] }, ctx: Ctx) {
    const medium = must(ctx.shared.get("medium"), "medium");
    const schedule = ctx.shared.get("schedule") ?? DEFAULT_SCHEDULE;
    const assets = input.assets ?? ctx.shared.get("assets") ?? [];
    if (assets.length === 0) {
      return terminate({ medium, schedule, rendered: 0, delivered: 0 });
    }

    // One shared inbox sends every recipient their own personalized asset.
    const inboxId = await resolveSenderInbox(ctx);
    const results: { recipientId: number; to: string; messageId?: string }[] =
      [];
    for (const asset of assets) {
      const link = asset.downloadUrl ?? "(asset link unavailable)";
      const subject = `${asset.name}, here's something we made for you`;
      const text =
        `Hi ${asset.name},\n\n` +
        `We put together a personalized ${asset.medium} just for you. ` +
        `You can view it here:\n\n${link}\n\n— The team`;
      // Degrade per-recipient: a bad address shouldn't sink the whole batch.
      try {
        const sent = await ctx.sapiom.email.messages.send(inboxId, {
          to: asset.email,
          subject,
          text,
        });
        results.push({
          recipientId: asset.recipientId,
          to: asset.email,
          messageId: sent.messageId,
        });
      } catch (err) {
        ctx.logger.warn("email failed for recipient", {
          recipientId: asset.recipientId,
          err: String(err),
        });
        results.push({ recipientId: asset.recipientId, to: asset.email });
      }
    }
    const delivered = results.filter((r) => r.messageId).length;
    ctx.logger.info("batch delivered", {
      medium,
      rendered: assets.length,
      delivered,
    });
    return terminate({
      medium,
      schedule,
      rendered: assets.length,
      delivered,
      recipients: results,
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "personalized-media-at-scale",
  entry: "fetch",
  steps: { fetch, renderImages, renderClip, collectClip, deliver },
});
