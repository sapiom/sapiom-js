import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Durable Backfill / Long-Job Runner — process a huge dataset in resumable
 * chunks, checkpointing progress to durable storage and surviving restarts.
 *
 * A pure durability showcase. Instead of one long-held worker grinding through a
 * million rows (and dying halfway with nothing to show), this walks the dataset
 * one bounded chunk at a time. After each chunk it writes a checkpoint, then
 * **suspends at $0** (`pauseUntilSignal`) until a heartbeat wakes it for the next
 * chunk — the "heartbeat" is a cron/schedule firing the resume signal on a
 * cadence. Nothing runs and nothing is billed between chunks.
 *
 *   plan ─▶ process ──(checkpoint, then pause: wait for heartbeat, $0)──╮
 *            ▲                                                          │
 *            ╰──────────────── resume on `backfill.heartbeat` ──────────╯
 *            │
 *            ╰─(no work left)─▶ finalize (terminal)
 *
 *   1. plan — resolve the job (dataset size, chunk size, job id). If a durable
 *      checkpoint already exists for this job id, resume from where it left off;
 *      otherwise start at zero.
 *   2. process — handle the current chunk. The real work runs in a sandbox that
 *      gets the dataset's `DATABASE_URL` (from the `database` capability) and the
 *      chunk range injected as env. It then persists a per-chunk result artifact
 *      and rewrites the durable checkpoint (`fileStorage`), advances the cursor,
 *      and pauses until the next heartbeat — or, when the last chunk is done,
 *      goes straight to `finalize`.
 *   3. finalize — write a manifest of the run and terminate with a summary.
 *
 * Restart survival has two layers. Within one execution, the cursor lives in
 * `ctx.shared` and survives every pause. Across a full teardown, the checkpoint
 * lives in file storage keyed by `jobId`, so a brand-new run started with the
 * same `jobId` reads it in `plan` and picks up mid-dataset.
 *
 * Offline: with no `dbHandle` (or `dryRun` set), `process` handles each chunk
 * in-process and skips the sandbox / database / file-storage calls, so
 * `run_local` traces the whole plan → process → … → finalize loop for free. The
 * local runner auto-resumes each heartbeat pause, so you see every chunk.
 */

/** String-only config bag (matches how templates receive their `config`). */
type Config = Record<string, string>;

/** The run input. Everything is optional and defaults to a small demo job. */
interface BackfillInput {
  /** Total items in the dataset to back-fill. */
  total?: number;
  /** Items per chunk — the unit of work between heartbeats. */
  chunkSize?: number;
  /**
   * Stable id for this backfill — the checkpoint key. Pass the same `jobId` to a
   * fresh run to resume an interrupted job. Defaults to the execution id.
   */
  jobId?: string;
  /**
   * Postgres handle (from the `database` capability) whose connection string is
   * injected into the chunk processor as `DATABASE_URL`. Absent ⇒ offline.
   */
  dbHandle?: string;
  /**
   * Shell command run once per chunk inside the sandbox, with `DATABASE_URL`,
   * `CHUNK_OFFSET`, `CHUNK_LIMIT`, and `JOB_ID` in its env. It should print the
   * number of items it processed as the last line of stdout. Swap in your real
   * backfill here; the default just echoes the chunk size.
   */
  command?: string;
  /** Process chunks in-process and skip all external calls. */
  dryRun?: boolean;
  /** Reserved for extra string config. */
  config?: Config;
}

/** The durable checkpoint — the small JSON that lets a fresh run resume. */
interface Checkpoint {
  jobId: string;
  /** Offset of the next unprocessed item. */
  cursor: number;
  /** Items processed so far. */
  processed: number;
  /** Chunks completed so far. */
  chunkIndex: number;
  /** Dataset size the checkpoint was written against. */
  total: number;
}

/** State that survives every pause (and is rebuilt from the checkpoint on resume). */
interface Shared extends Record<string, unknown> {
  jobId: string;
  total: number;
  chunkSize: number;
  cursor: number;
  processed: number;
  chunkIndex: number;
  dbHandle: string | null;
  command: string;
  dryRun: boolean;
  /** Latest checkpoint file id, so each write can delete the previous one. */
  checkpointFileId: string | null;
  /** Per-chunk result artifact ids, gathered into the final manifest. */
  resultFileIds: string[];
}

type Ctx = AgentExecutionContext<Shared>;

/** The heartbeat signal a cron/schedule fires to advance to the next chunk. */
const HEARTBEAT = "backfill.heartbeat";

const DEFAULT_TOTAL = 25;
const DEFAULT_CHUNK_SIZE = 10;
/** Default chunk command — echoes the chunk size so `parseCount` reads it back. */
const DEFAULT_COMMAND =
  'echo "processing $CHUNK_LIMIT items from offset $CHUNK_OFFSET (job $JOB_ID)"; echo "$CHUNK_LIMIT"';
/** Time-to-live for the per-chunk sandbox — short, since it is torn down each chunk. */
const CHUNK_SANDBOX_TTL = "15m";

// ---- helpers ---------------------------------------------------------------
function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing shared state: ${name}`);
  return value;
}

/** File name the durable checkpoint is stored under, keyed by job id. */
function checkpointFileName(jobId: string): string {
  return `backfill-checkpoint-${jobId}.json`;
}

/**
 * A sandbox name is lowercase alphanumeric + hyphens, 2–63 chars. Derive a legal
 * one from the job id and chunk offset.
 */
function sandboxName(jobId: string, offset: number): string {
  const base = `backfill-${jobId}-c${offset}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "backfill").slice(0, 63);
}

/** Read the last integer printed by the chunk command; fall back to the chunk size. */
function parseCount(stdout: string, fallback: number): number {
  const matches = stdout.match(/-?\d+/g);
  if (!matches || matches.length === 0) return fallback;
  const n = Number(matches[matches.length - 1]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Upload a small JSON object to file storage; return its file id (or null on failure). */
async function uploadJson(
  ctx: Ctx,
  fileName: string,
  obj: unknown,
): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
    const { fileId, uploadUrl, requiredHeaders } =
      await ctx.sapiom.fileStorage.upload({
        contentType: "application/json",
        fileName,
        visibility: "private",
        fileSize: bytes.byteLength,
      });
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: requiredHeaders,
      body: bytes,
    });
    if (!put.ok) {
      ctx.logger.warn("checkpoint/result upload PUT failed", {
        fileName,
        status: put.status,
      });
      return null;
    }
    return fileId;
  } catch (err) {
    ctx.logger.warn("upload failed", { fileName, err: String(err) });
    return null;
  }
}

/** Delete a file id, swallowing errors (rotation is best-effort). */
async function deleteFile(ctx: Ctx, fileId: string): Promise<void> {
  try {
    await ctx.sapiom.fileStorage.delete(fileId);
  } catch (err) {
    ctx.logger.warn("checkpoint delete failed", { fileId, err: String(err) });
  }
}

/**
 * Load the durable checkpoint for `jobId` from file storage, if one exists. A
 * fresh execution started with the same `jobId` uses this to resume mid-dataset.
 */
async function readCheckpoint(
  ctx: Ctx,
  jobId: string,
): Promise<Checkpoint | null> {
  const name = checkpointFileName(jobId);
  try {
    const listing = await ctx.sapiom.fileStorage.list({ limit: 100 });
    const files = listing?.files ?? [];
    const match = files.find(
      (f) => f.fileName === name && f.status === "uploaded",
    );
    if (!match) return null;
    const { downloadUrl } = await ctx.sapiom.fileStorage.getDownloadUrl(
      match.fileId,
    );
    const res = await fetch(downloadUrl);
    if (!res.ok) return null;
    const cp = (await res.json()) as Partial<Checkpoint>;
    if (typeof cp.cursor !== "number") return null;
    ctx.shared.set("checkpointFileId", match.fileId);
    return {
      jobId,
      cursor: cp.cursor,
      processed: typeof cp.processed === "number" ? cp.processed : 0,
      chunkIndex: typeof cp.chunkIndex === "number" ? cp.chunkIndex : 0,
      total: typeof cp.total === "number" ? cp.total : 0,
    };
  } catch (err) {
    ctx.logger.warn("checkpoint read failed", { jobId, err: String(err) });
    return null;
  }
}

/**
 * Do one chunk's work. Real path: spin up a sandbox with the dataset's
 * `DATABASE_URL` and the chunk range in its env, run the command, tear the
 * sandbox down. Offline path (`dryRun`): count the chunk in-process. Returns the
 * number of items processed.
 */
async function processChunk(
  ctx: Ctx,
  args: {
    command: string;
    dbHandle: string | null;
    offset: number;
    limit: number;
    jobId: string;
    dryRun: boolean;
  },
): Promise<number> {
  if (args.dryRun) {
    ctx.logger.info("dry run: processing chunk in-process (no sandbox)", {
      offset: args.offset,
      limit: args.limit,
    });
    return args.limit;
  }

  // Resolve the dataset connection string to hand the processor.
  let databaseUrl: string | undefined;
  if (args.dbHandle) {
    try {
      const db = await ctx.sapiom.database.get(args.dbHandle);
      databaseUrl = db.connection?.connectionString ?? undefined;
    } catch (err) {
      ctx.logger.warn("could not resolve DATABASE_URL from handle", {
        handle: args.dbHandle,
        err: String(err),
      });
    }
  }

  const box = await ctx.sapiom.sandboxes.create({
    name: sandboxName(args.jobId, args.offset),
    ttl: CHUNK_SANDBOX_TTL,
    envs: {
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      CHUNK_OFFSET: String(args.offset),
      CHUNK_LIMIT: String(args.limit),
      JOB_ID: args.jobId,
    },
  });
  try {
    const res = await box.exec(args.command);
    if (res.exitCode !== 0) {
      ctx.logger.warn("chunk command exited non-zero", {
        exitCode: res.exitCode,
        stderr: res.stderr.slice(0, 200),
      });
    }
    return parseCount(res.stdout, args.limit);
  } finally {
    try {
      await box.destroy();
    } catch (err) {
      ctx.logger.warn("sandbox destroy failed", { err: String(err) });
    }
  }
}

// ---- steps -----------------------------------------------------------------
const plan = defineStep({
  name: "plan",
  next: ["process"],
  async run(input: BackfillInput, ctx: Ctx) {
    const total = Math.max(0, Math.floor(input.total ?? DEFAULT_TOTAL));
    const chunkSize = Math.max(
      1,
      Math.floor(input.chunkSize ?? DEFAULT_CHUNK_SIZE),
    );
    const jobId = (input.jobId ?? "").trim() || ctx.executionId;
    const dbHandle = (input.dbHandle ?? "").trim() || null;
    const command = (input.command ?? "").trim() || DEFAULT_COMMAND;
    // No dataset handle (or explicit dryRun) ⇒ run offline: no sandbox, DB, or
    // file storage, so run_local traces the whole loop for free.
    const dryRun = input.dryRun === true || !dbHandle;

    let cursor = 0;
    let processed = 0;
    let chunkIndex = 0;
    if (!dryRun) {
      const prior = await readCheckpoint(ctx, jobId);
      if (prior) {
        cursor = Math.min(prior.cursor, total);
        processed = prior.processed;
        chunkIndex = prior.chunkIndex;
        ctx.logger.info("resuming from checkpoint", {
          jobId,
          cursor,
          processed,
          chunkIndex,
        });
      }
    }

    ctx.shared.set("jobId", jobId);
    ctx.shared.set("total", total);
    ctx.shared.set("chunkSize", chunkSize);
    ctx.shared.set("cursor", cursor);
    ctx.shared.set("processed", processed);
    ctx.shared.set("chunkIndex", chunkIndex);
    ctx.shared.set("dbHandle", dbHandle);
    ctx.shared.set("command", command);
    ctx.shared.set("dryRun", dryRun);
    ctx.shared.set("resultFileIds", []);
    if (ctx.shared.get("checkpointFileId") === undefined) {
      ctx.shared.set("checkpointFileId", null);
    }

    ctx.logger.info("backfill planned", {
      jobId,
      total,
      chunkSize,
      cursor,
      dryRun,
    });
    return goto("process", {});
  },
});

const processStep = defineStep({
  name: "process",
  next: ["finalize"],
  // Self-loop: after checkpointing a chunk, pause until the heartbeat fires and
  // resume this same step for the next chunk.
  pause: { signal: HEARTBEAT, resumeStep: "process" },
  async run(_input: unknown, ctx: Ctx) {
    const jobId = must(ctx.shared.get("jobId"), "jobId");
    const total = must(ctx.shared.get("total"), "total");
    const chunkSize = must(ctx.shared.get("chunkSize"), "chunkSize");
    const cursor = must(ctx.shared.get("cursor"), "cursor");
    const dryRun = ctx.shared.get("dryRun") === true;
    const dbHandle = (ctx.shared.get("dbHandle") as string | null) ?? null;
    const command = must(ctx.shared.get("command"), "command");

    // Nothing left to do — finalize. (Also the safe landing if woken with no work.)
    if (cursor >= total) return goto("finalize", {});

    const offset = cursor;
    const limit = Math.min(chunkSize, total - cursor);
    const chunkIndex = must(ctx.shared.get("chunkIndex"), "chunkIndex");
    ctx.logger.info("processing chunk", {
      jobId,
      chunkIndex,
      offset,
      limit,
      total,
    });

    const done = await processChunk(ctx, {
      command,
      dbHandle,
      offset,
      limit,
      jobId,
      dryRun,
    });

    // Persist a per-chunk result artifact (deployed path only).
    const resultFileIds = [
      ...((ctx.shared.get("resultFileIds") as string[] | undefined) ?? []),
    ];
    if (!dryRun) {
      const rid = await uploadJson(
        ctx,
        `backfill-${jobId}-chunk-${chunkIndex}.json`,
        { jobId, chunkIndex, offset, limit, processed: done },
      );
      if (rid) resultFileIds.push(rid);
    }

    // Advance the cursor and record progress.
    const nextCursor = offset + limit;
    const nextProcessed = must(ctx.shared.get("processed"), "processed") + done;
    const nextChunkIndex = chunkIndex + 1;
    ctx.shared.set("cursor", nextCursor);
    ctx.shared.set("processed", nextProcessed);
    ctx.shared.set("chunkIndex", nextChunkIndex);
    ctx.shared.set("resultFileIds", resultFileIds);

    // Rewrite the durable checkpoint, rotating out the previous file.
    if (!dryRun) {
      const prevCheckpoint = ctx.shared.get("checkpointFileId") as
        | string
        | null;
      const cpId = await uploadJson(ctx, checkpointFileName(jobId), {
        jobId,
        cursor: nextCursor,
        processed: nextProcessed,
        chunkIndex: nextChunkIndex,
        total,
      } satisfies Checkpoint);
      if (cpId) {
        if (prevCheckpoint && prevCheckpoint !== cpId) {
          await deleteFile(ctx, prevCheckpoint);
        }
        ctx.shared.set("checkpointFileId", cpId);
      }
    }
    ctx.logger.info("chunk checkpointed", {
      jobId,
      cursor: nextCursor,
      processed: nextProcessed,
    });

    // Last chunk done? Finalize now. Otherwise wait for the next heartbeat.
    if (nextCursor >= total) return goto("finalize", {});
    return pauseUntilSignal({
      signal: HEARTBEAT,
      resumeStep: "process",
      correlationId: ctx.executionId,
    });
  },
});

const finalize = defineStep({
  name: "finalize",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const jobId = must(ctx.shared.get("jobId"), "jobId");
    const total = must(ctx.shared.get("total"), "total");
    const processed = must(ctx.shared.get("processed"), "processed");
    const chunkIndex = must(ctx.shared.get("chunkIndex"), "chunkIndex");
    const dryRun = ctx.shared.get("dryRun") === true;
    const checkpointFileId =
      (ctx.shared.get("checkpointFileId") as string | null) ?? null;
    const resultFileIds =
      (ctx.shared.get("resultFileIds") as string[] | undefined) ?? [];

    let manifestFileId: string | null = null;
    if (!dryRun) {
      manifestFileId = await uploadJson(
        ctx,
        `backfill-${jobId}-manifest.json`,
        { jobId, total, processed, chunks: chunkIndex, resultFileIds },
      );
    }

    ctx.logger.info("backfill complete", {
      jobId,
      total,
      processed,
      chunks: chunkIndex,
    });
    return terminate({
      jobId,
      total,
      processed,
      chunks: chunkIndex,
      complete: total === 0 || processed >= total,
      checkpointFileId,
      manifestFileId,
      resultFileIds,
    });
  },
});

export const agent = defineAgent<BackfillInput, Shared>({
  name: "durable-backfill",
  entry: "plan",
  steps: { plan, process: processStep, finalize },
});
