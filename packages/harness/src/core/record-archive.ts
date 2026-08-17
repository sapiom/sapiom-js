/**
 * Durable session records — what makes session history outlive the raw event
 * log it was rebuilt from.
 *
 * THE PROBLEM. `events.ndjson` is an analytics sink with an analytics sink's
 * retention: 50 MB / 30 days, truncated oldest-first (core/collector/
 * store-retention.ts). Once session history is *built on* that file
 * (core/session-record.ts), the sweep silently deletes history — a session a
 * user can read today is gone next month, with no way to tell "never existed"
 * from "swept". A record the user can open is a product surface; a byte cap on
 * an append-only debug log is not the right lifetime for it.
 *
 * THE FIX. At session end we fold the record once and write a compacted copy to
 * `~/.sapiom/harness/records/<harnessSessionId>.json`. It is bounded (see the
 * caps below), it is one file per conversation, and it survives every sweep of
 * the ndjson because it isn't in it. The ndjson goes back to being what it is:
 * the raw analytics sink.
 *
 * WHY NOT UNDER `<generated>/<sessionId>/`, which the ticket suggested and
 * which already has a retention sweep: that directory is deleted the moment a
 * session's pty exits (server/index.ts's "exited" handler calls
 * removeGeneratedSessionDir — every file in it is regenerated on the next
 * launch), and whatever survives that is swept 7 days after it goes stale.
 * Both lifetimes are *shorter* than the 30 days of events the archive exists to
 * outlive, so a record written there would die sooner than the log it was meant
 * to survive. Records get their own root and their own policy instead.
 *
 * COMPACTION is lossy, on purpose, and says so. Tool inputs and tool results
 * are the bulk of the bytes (`tool.call` was ~80% of observed event volume) and
 * the least useful part of a record read weeks later, so they are clipped hard;
 * prompts and assistant text — the conversation — are clipped only at the
 * collector's own field cap, so in practice they are kept whole. Every loss
 * lands in `SessionRecord.limitations` (`compacted-archive`,
 * `dropped-early-turns`) and the UI renders it as prose, per this epic's rule
 * that a reconstruction never gets to imply it is complete.
 *
 * SIZE CEILING, stated exactly: a record is compacted to at most
 * {@link RECORD_MAX_BYTES} by clipping fields and then dropping whole turns
 * oldest-first — but never below one turn. A single turn with hundreds of tool
 * calls can therefore exceed the per-record cap; the store's total-bytes cap
 * ({@link RECORDS_MAX_TOTAL_BYTES}, enforced against real file sizes) is the
 * hard bound, and one outsized record just crowds out older ones sooner.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SessionRecord, SessionRecordLimitation, SessionRecordTurn } from "../shared/types.js";
import { PAYLOAD_TRUNCATION_MARKER } from "./collector/normalizer.js";
import { childPath } from "./path-safety.js";

/** Tool input, clipped hard: a 40 KB Edit payload is not what makes a
 *  months-old record worth keeping, and it is most of its bytes. */
export const RECORDS_MAX_TOOL_INPUT_CHARS = 512;
/** Tool result, same reasoning. The collector already caps these at 16 KB. */
export const RECORDS_MAX_TOOL_RESPONSE_CHARS = 512;
/** Prompts and assistant text — the conversation itself. Set at the
 *  collector's own field cap (normalizer.ts's MAX_FIELD_LENGTH), so this
 *  clips nothing the log didn't already clip. Kept as our own constant
 *  because the archive's contract is "the conversation survives whole". */
export const RECORDS_MAX_TEXT_CHARS = 4000;
/** Per-record byte ceiling — see the module header for the one case that
 *  legitimately exceeds it. ~64 KB holds a long session comfortably once tool
 *  payloads are clipped. */
export const RECORD_MAX_BYTES = 64 * 1024;
/** Whole-store byte ceiling. A third of the raw sink's 50 MB, for two orders
 *  of magnitude more sessions: at 64 KB worst-case per record it guarantees
 *  256 archived conversations, and at realistic sizes holds thousands. */
export const RECORDS_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Age ceiling. Deliberately far longer than the events' 30 days — the whole
 *  point of the archive is to outlive them — while still bounded, so an
 *  install that runs for years doesn't accumulate forever. */
export const RECORDS_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A record that has been through the archive: identical to a {@link
 * SessionRecord} except that `archivedAt` is known to be set. The distinction
 * is load-bearing for the reader, which compares that stamp against the event
 * log to decide which of the two sources still holds the whole conversation.
 */
export type ArchivedSessionRecord = SessionRecord & { archivedAt: string };

/** What the archive knows about one stored record without reading it again. */
export interface ArchivedRecordSummary {
  /** Primary id the record is filed under (the conversation's first session). */
  harnessSessionId: string;
  /** Every id this record answers to: primary, merged sessions, agent session. */
  keys: string[];
  /** Human turns in the CONVERSATION (not necessarily in the stored turns —
   *  see `SessionRecord.turnCount`). */
  turnCount: number;
  /** ISO-8601 of when the record was archived. */
  archivedAt: string;
  /** Size of the file on disk. */
  bytes: number;
  /** Absolute path of the record file. */
  file: string;
}

export interface RecordArchiveOptions {
  /** Root the record files live in. Required — the caller resolves it from the
   *  server's state root so an isolated boot never writes to the real home. */
  root: string;
  maxRecordBytes?: number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Diagnostics sink. Defaults to console.error. */
  onError?: (err: unknown) => void;
}

export interface RecordArchive {
  /**
   * Compact `record` and write it, replacing any earlier archive of the same
   * conversation. Returns what was written, or null when there was nothing
   * worth archiving (a record with no turns) or the write failed — never
   * throws: failing to archive must not take a session's exit down with it.
   */
  write(record: SessionRecord): Promise<ArchivedSessionRecord | null>;
  /**
   * The archived record for `id` — a harnessSessionId (primary or merged) or
   * the agent's own session id — or null when there is none. Never throws; a
   * corrupt file reads as absent.
   */
  read(id: string): Promise<ArchivedSessionRecord | null>;
  /** True when {@link read} would find a record, without reading the file. */
  has(id: string): Promise<boolean>;
  /** Every stored record's summary, newest first. */
  list(): Promise<ArchivedRecordSummary[]>;
  /**
   * Enforce the age and total-size caps, oldest-first. Returns the primary ids
   * removed. Best-effort per file: one undeletable record doesn't abort the
   * rest.
   */
  sweep(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Compaction — pure
// ---------------------------------------------------------------------------

/**
 * Clip a nullable string to `maxChars`, wearing the same marker the collector
 * uses — so an archive-clipped tool result is recognized as truncated by
 * exactly the test the collector's own truncation is (see session-record.ts).
 *
 * An existing marker is UNWRAPPED first and its count folded into the new one.
 * Two things fall out of that, both load-bearing: the collector's 16 KB tool
 * results (which already end in a marker, and are the bytes worth taking) get
 * clipped rather than waved through, and clipping is idempotent — a second pass
 * finds a body already at the cap and returns it untouched, instead of eating
 * the marker and shaving another 23 characters off the text every time a
 * record is re-archived.
 */
function clip(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  const marker = PAYLOAD_TRUNCATION_MARKER.exec(value);
  const body = marker ? value.slice(0, value.length - marker[0].length) : value;
  const alreadyOmitted = marker ? Number(marker[1]) : 0;
  if (body.length <= maxChars) return value;
  // Same converging-slice fix as truncateForPayload, plus the unwrap step
  // above: the omitted count folds in whatever a prior pass already cut, and
  // idempotency holds because the fixed point always lands the body at
  // exactly `maxChars - newMarker.length`, which a second pass's unwrap step
  // reproduces exactly (see truncateForPayload's doc comment for why this
  // needs a loop instead of a single subtraction).
  let sliceLen = maxChars;
  for (let i = 0; i < 5; i++) {
    const omitted = body.length - sliceLen + alreadyOmitted;
    const newMarker = `…[truncated ${omitted} chars]`;
    const nextSliceLen = Math.max(0, maxChars - newMarker.length);
    if (nextSliceLen === sliceLen) {
      return `${body.slice(0, sliceLen)}${newMarker}`.slice(0, maxChars);
    }
    sliceLen = nextSliceLen;
  }
  const omitted = body.length - sliceLen + alreadyOmitted;
  const newMarker = `…[truncated ${omitted} chars]`;
  return `${body.slice(0, sliceLen)}${newMarker}`.slice(0, maxChars);
}

export interface CompactionOptions {
  maxBytes?: number;
  maxToolInputChars?: number;
  maxToolResponseChars?: number;
  maxTextChars?: number;
  /** ISO-8601 stamp to record as `archivedAt`. Defaults to now. */
  archivedAt?: string;
}

/**
 * The bounded, archivable form of a record: fields clipped, oldest turns
 * dropped if it still doesn't fit, and every loss declared in `limitations`.
 *
 * Pure and idempotent — compacting an already-compacted record clips nothing
 * further and drops nothing further, which matters because a re-archive
 * (a session that ends twice, a backfill) must not shrink a record a little
 * more each time.
 *
 * `turnCount` and `eventCount` deliberately keep their pre-compaction values:
 * they describe the conversation that happened, not the excerpt that survived.
 * A history row's turn count therefore doesn't change when its record is
 * archived, and `dropped-early-turns` is what tells the reader that `turns`
 * holds fewer than `turnCount` of them.
 */
export function compactSessionRecord(
  record: SessionRecord,
  options: CompactionOptions = {},
): ArchivedSessionRecord {
  const maxBytes = options.maxBytes ?? RECORD_MAX_BYTES;
  const maxToolInputChars = options.maxToolInputChars ?? RECORDS_MAX_TOOL_INPUT_CHARS;
  const maxToolResponseChars = options.maxToolResponseChars ?? RECORDS_MAX_TOOL_RESPONSE_CHARS;
  const maxTextChars = options.maxTextChars ?? RECORDS_MAX_TEXT_CHARS;
  const archivedAt = options.archivedAt ?? new Date().toISOString();

  const clipped: SessionRecordTurn[] = record.turns.map((turn) => ({
    ...turn,
    prompt: clip(turn.prompt, maxTextChars),
    assistantText: clip(turn.assistantText, maxTextChars),
    toolCalls: turn.toolCalls.map((call) => {
      const responseSummary = clip(call.responseSummary, maxToolResponseChars);
      return {
        ...call,
        input: clip(call.input, maxToolInputChars),
        responseSummary,
        // Recomputed rather than carried: a response this pass shortened is
        // truncated whether or not the collector had already truncated it.
        responseTruncated: call.responseTruncated || responseSummary !== call.responseSummary,
      };
    }),
  }));

  // Cumulative-bytes pass rather than re-serializing the record per dropped
  // turn (the same shape store-retention.ts's size cap uses, and for the same
  // reason: a marathon session shouldn't cost O(n²) to archive).
  const turnBytes = clipped.map((turn) => Buffer.byteLength(JSON.stringify(turn), "utf8") + 1);
  // Measured against the record this function will RETURN, at its largest: the
  // stamp is set and both archive limitation codes may be added. Measuring the
  // (smaller) input's header instead would let the result overshoot the cap by
  // their bytes — a cap that is only nearly a cap isn't one.
  const headerBytes = Buffer.byteLength(
    JSON.stringify({
      ...record,
      turns: [],
      archivedAt,
      limitations: [...new Set([...record.limitations, "compacted-archive", "dropped-early-turns"])],
    }),
    "utf8",
  );
  let total = turnBytes.reduce((sum, n) => sum + n, headerBytes);
  let dropCount = 0;
  // Never drop the last turn: an empty archive is strictly worse than one that
  // overshoots the cap, and the store's total-bytes cap still bounds the whole.
  while (dropCount < clipped.length - 1 && total > maxBytes) {
    total -= turnBytes[dropCount];
    dropCount += 1;
  }
  const turns = dropCount > 0 ? clipped.slice(dropCount) : clipped;

  const limitations = new Set<SessionRecordLimitation>(record.limitations);
  // Judged on the turns that SURVIVED: a clip inside a turn that was dropped
  // wholesale is already covered by `dropped-early-turns`, and claiming
  // "content was shortened" for text nobody can look for reads as a second,
  // separate loss.
  if (turns.some((turn, index) => turnChangedByCompaction(record.turns[dropCount + index], turn))) {
    limitations.add("compacted-archive");
  }
  // `truncated-tool-output` can newly become true here: a result the collector
  // kept whole may have been clipped by this pass.
  if (turns.some((turn) => turn.toolCalls.some((call) => call.responseTruncated))) {
    limitations.add("truncated-tool-output");
  }
  if (dropCount > 0) limitations.add("dropped-early-turns");

  return { ...record, turns, limitations: [...limitations], archivedAt };
}

function turnChangedByCompaction(before: SessionRecordTurn, after: SessionRecordTurn): boolean {
  if (before.prompt !== after.prompt) return true;
  if (before.assistantText !== after.assistantText) return true;
  return before.toolCalls.some(
    (call, index) =>
      call.input !== after.toolCalls[index].input ||
      call.responseSummary !== after.toolCalls[index].responseSummary,
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Every id a record should be findable by. A conversation is addressed by its
 *  primary session id, by any session that resumed it, and by the agent's own
 *  session id (transcript-sourced history rows only have the latter). */
function keysFor(record: SessionRecord): string[] {
  const keys = [record.harnessSessionId, ...record.mergedSessionIds];
  if (record.agentSessionId) keys.push(record.agentSessionId);
  return [...new Set(keys.filter((key) => key.length > 0))];
}

interface ArchiveIndex {
  byKey: Map<string, ArchivedRecordSummary>;
  records: ArchivedRecordSummary[];
  /** mtime of the root directory the index was built from. */
  dirMtimeMs: number;
}

const EMPTY_INDEX: ArchiveIndex = { byKey: new Map(), records: [], dirMtimeMs: -1 };

function parseRecord(text: string): ArchivedSessionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<SessionRecord>;
  // A file without these can't be placed or rendered, so it isn't a record as
  // far as the archive is concerned — treated as absent, never thrown on.
  if (typeof candidate.harnessSessionId !== "string") return null;
  if (!Array.isArray(candidate.turns) || !Array.isArray(candidate.mergedSessionIds)) return null;
  if (typeof candidate.archivedAt !== "string") return null;
  return candidate as ArchivedSessionRecord;
}

export function createRecordArchive(options: RecordArchiveOptions): RecordArchive {
  const root = options.root;
  const maxRecordBytes = options.maxRecordBytes ?? RECORD_MAX_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? RECORDS_MAX_TOTAL_BYTES;
  const maxAgeMs = options.maxAgeMs ?? RECORDS_MAX_AGE_MS;
  const now = options.now ?? (() => Date.now());
  const onError =
    options.onError ?? ((err: unknown) => console.error("[harness] session record archive:", err));

  /**
   * Cached directory index. Invalidated by the root's mtime, which changes when
   * a file is created or removed — so a second harness boot writing to the same
   * root is picked up. (Coarse-mtime filesystems can hide a foreign write made
   * within the same second as our scan; it self-heals on the next one. Our own
   * writes update the cache directly and never depend on that.)
   */
  let cache: ArchiveIndex | null = null;

  /**
   * Serializes the two mutating operations. Both archive triggers
   * (server/index.ts: the `session.end` event and the session's exit) can fire
   * for one session within the same millisecond, and a sweep can land on top —
   * so without this, two writes race for the same temp path and one of them
   * renames a file the other already moved. Reads stay outside the queue: they
   * only ever open a whole file that a rename put there atomically.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => {}).then(run);
    queue = next.catch(() => {});
    return next;
  }

  /** Distinguishes temp files written in the same millisecond by the same pid. */
  let tmpCounter = 0;

  function fileFor(harnessSessionId: string): string | null {
    return childPath(root, `${harnessSessionId}.json`);
  }

  async function buildIndex(dirMtimeMs: number): Promise<ArchiveIndex> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
    if (!entries) return { ...EMPTY_INDEX, dirMtimeMs };
    const byKey = new Map<string, ArchivedRecordSummary>();
    const records: ArchivedRecordSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = childPath(root, entry.name);
      if (!file) continue;
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (text === null) continue;
      const record = parseRecord(text);
      if (!record) continue;
      const summary: ArchivedRecordSummary = {
        harnessSessionId: record.harnessSessionId,
        keys: keysFor(record),
        turnCount: record.turnCount,
        archivedAt: record.archivedAt,
        bytes: Buffer.byteLength(text, "utf8"),
        file,
      };
      records.push(summary);
      for (const key of summary.keys) {
        // First writer wins per key, and records are visited in readdir order,
        // so a stray duplicate (two archives claiming one agent session) can't
        // make the lookup depend on which one was read last: the primary file
        // named after the requested id is still found by the direct hit in
        // read(), which never consults this map.
        if (!byKey.has(key)) byKey.set(key, summary);
      }
    }
    records.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0));
    return { byKey, records, dirMtimeMs };
  }

  async function index(): Promise<ArchiveIndex> {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat) {
      cache = null;
      return EMPTY_INDEX;
    }
    if (cache && cache.dirMtimeMs === stat.mtimeMs) return cache;
    const built = await buildIndex(stat.mtimeMs);
    cache = built;
    return built;
  }

  async function readFile(file: string): Promise<ArchivedSessionRecord | null> {
    const text = await fs.readFile(file, "utf8").catch(() => null);
    return text === null ? null : parseRecord(text);
  }

  async function writeRecord(record: SessionRecord): Promise<ArchivedSessionRecord | null> {
    // Nothing to preserve: a session that recorded no turn at all reads the
    // same after the sweep as before it ("no recorded events"), and writing a
    // turn-less file would spend the store's budget saying so.
    if (record.turns.length === 0) return null;
    const file = fileFor(record.harnessSessionId);
    if (!file) {
      onError(new Error(`refusing to archive a record with an unsafe session id "${record.harnessSessionId}"`));
      return null;
    }
    const compacted = compactSessionRecord(record, {
      maxBytes: maxRecordBytes,
      archivedAt: new Date(now()).toISOString(),
    });
    const body = `${JSON.stringify(compacted)}\n`;
    // Atomic replace (temp + rename in the same directory), so a crash
    // mid-write can never leave a half-written record where a whole one was.
    tmpCounter += 1;
    const tmpFile = path.join(root, `.record-tmp-${process.pid}-${now()}-${tmpCounter}.json`);
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(tmpFile, body, "utf8");
      await fs.rename(tmpFile, file);
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => undefined);
      onError(err);
      return null;
    }
    // Keep the cache correct without re-reading every file: upsert this
    // summary and adopt the root's new mtime as the one we're current with.
    const summary: ArchivedRecordSummary = {
      harnessSessionId: compacted.harnessSessionId,
      keys: keysFor(compacted),
      turnCount: compacted.turnCount,
      archivedAt: compacted.archivedAt,
      bytes: Buffer.byteLength(body, "utf8"),
      file,
    };
    if (cache) {
      const records = cache.records.filter((entry) => entry.file !== file);
      records.unshift(summary);
      const byKey = new Map(cache.byKey);
      for (const key of summary.keys) byKey.set(key, summary);
      const stat = await fs.stat(root).catch(() => null);
      cache = { byKey, records, dirMtimeMs: stat?.mtimeMs ?? -1 };
    }
    return compacted;
  }

  async function sweepRecords(): Promise<string[]> {
    const { records } = await index();
    if (records.length === 0) return [];
    // Oldest first — both caps evict in that order.
    const oldestFirst = [...records].reverse();
    const cutoffMs = now() - maxAgeMs;
    let totalBytes = oldestFirst.reduce((sum, entry) => sum + entry.bytes, 0);
    const doomed: ArchivedRecordSummary[] = [];
    for (const entry of oldestFirst) {
      const archivedMs = Date.parse(entry.archivedAt);
      const expired = !Number.isNaN(archivedMs) && archivedMs < cutoffMs;
      if (!expired && totalBytes <= maxTotalBytes) break;
      doomed.push(entry);
      totalBytes -= entry.bytes;
    }
    const removed: string[] = [];
    for (const entry of doomed) {
      try {
        await fs.unlink(entry.file);
        removed.push(entry.harnessSessionId);
      } catch {
        // Leave it for the next sweep rather than aborting the rest.
      }
    }
    if (removed.length > 0) cache = null;
    return removed;
  }

  return {
    write(record: SessionRecord): Promise<ArchivedSessionRecord | null> {
      return enqueue(() => writeRecord(record));
    },

    async read(id: string): Promise<ArchivedSessionRecord | null> {
      // Direct hit first — the overwhelmingly common case (a row addressed by
      // the id its record is filed under) costs one file read and never builds
      // the directory index.
      const direct = fileFor(id);
      if (direct) {
        const record = await readFile(direct);
        if (record) return record;
      }
      const summary = (await index()).byKey.get(id);
      if (!summary) return null;
      return readFile(summary.file);
    },

    async has(id: string): Promise<boolean> {
      const direct = fileFor(id);
      if (direct) {
        const stat = await fs.stat(direct).catch(() => null);
        if (stat?.isFile()) return true;
      }
      return (await index()).byKey.has(id);
    },

    async list(): Promise<ArchivedRecordSummary[]> {
      return [...(await index()).records];
    },

    sweep(): Promise<string[]> {
      return enqueue(sweepRecords);
    },
  };
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** Conversations present in the event log, newest activity first. */
  conversationIds: () => Promise<string[]>;
  /** Fold a conversation from the events alone (never from the archive). */
  readFromEvents: (harnessSessionId: string) => Promise<SessionRecord | null>;
  archive: Pick<RecordArchive, "has" | "write">;
  /** A live session is still writing events; archiving it now would store a
   *  half-finished record and pre-empt the archive its exit will write. */
  isLiveSession?: (harnessSessionId: string) => boolean;
  /** Ceiling on how many conversations one pass archives. */
  maxRecords?: number;
  /** Called with the number of eligible conversations left unarchived when the
   *  cap cut the pass short — a bounded pass must say what it didn't do. */
  onCapped?: (remaining: number) => void;
}

/** Default ceiling for one backfill pass. High enough to cover a typical
 *  install's whole history on the first boot after this shipped, low enough
 *  that a pathological log doesn't turn boot into a write storm. Whatever is
 *  left is archived by the next boot's pass. */
export const RECORDS_BACKFILL_MAX = 200;

/**
 * Archive conversations the event log still holds but the archive doesn't.
 *
 * Two things need this, and neither is covered by archiving at session end:
 * sessions that ended without one (the harness force-killed, the machine
 * rebooted), and every session that ended *before* this feature existed — whose
 * history would otherwise disappear at its 30-day mark with the archive looking
 * on. Idempotent: a conversation already archived is skipped, so the steady
 * state after the first pass is "nothing to do".
 *
 * Never throws. Returns the ids it archived.
 */
export async function backfillSessionRecords(options: BackfillOptions): Promise<string[]> {
  const maxRecords = options.maxRecords ?? RECORDS_BACKFILL_MAX;
  const ids = await options.conversationIds();
  const archived: string[] = [];
  let remaining = 0;
  for (const id of ids) {
    if (options.isLiveSession?.(id)) continue;
    if (await options.archive.has(id)) continue;
    if (archived.length >= maxRecords) {
      remaining += 1;
      continue;
    }
    const record = await options.readFromEvents(id);
    if (!record) continue;
    const written = await options.archive.write(record);
    if (written) archived.push(id);
  }
  if (remaining > 0) options.onCapped?.(remaining);
  return archived;
}
