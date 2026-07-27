/**
 * Append-only local sink for analytics events. Always written, regardless
 * of telemetry opt-in — this is the "demo inspects this" local debug file,
 * independent of whether anything gets batched to a remote collector.
 *
 * Concurrency: every append is serialized through a promise queue (the same
 * pattern as workflow-registry.ts and session-manager.ts). `runExclusive(fn)`
 * chains `fn` onto the same queue so retention sweeps (read→filter→rename)
 * never overlap with an in-flight append and no appended line can be lost
 * in a sweep's read window. Overhead is negligible — appends are low-frequency
 * (one per hook event), and the queue never holds more than O(sessions) entries.
 *
 * Reads (`read`, `index`) run deliberately OUTSIDE that queue: an append is a
 * single `appendFile` of one line, so a reader can never be left waiting out a
 * half-written record it would otherwise have to skip — the worst case is a
 * torn final line from a crash, which the parser drops. Blocking writers
 * behind a 50 MB scan to buy nothing would be the wrong trade.
 *
 * Index: reading one session's events must not rescan the whole file (capped
 * at 50 MB — see store-retention.ts). The index maps each harnessSessionId to
 * the byte spans its lines occupy. It is built lazily on the first read and
 * maintained incrementally after that: each subsequent read scans only the
 * bytes appended since the last one — by this process or by a second harness
 * boot writing to the same file, which is why the trigger is the file's size
 * rather than our own append path. A shrink or an inode change means the file
 * was rewritten underneath us (a retention sweep), which invalidates every
 * offset, so the index is rebuilt from scratch.
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { StringDecoder } from "node:string_decoder";

import {
  HARNESS_PATHS,
  type AnalyticsEvent,
  type AnalyticsEventType,
  type HarnessKind,
} from "../../shared/types.js";
import { expandHome } from "../paths.js";

/** Bytes read per positioned read when walking a span (see readSpanLines). */
const SPAN_CHUNK_BYTES = 1024 * 1024;

/** A half-open byte range `[start, end)` of the ndjson file. */
export interface ByteSpan {
  start: number;
  end: number;
}

/** What the index knows about one harnessSessionId. */
export interface EventIndexEntry {
  harnessSessionId: string;
  /** Byte spans holding this session's lines, ascending, adjacent ones merged. */
  spans: ByteSpan[];
  /** Total events recorded for the session. */
  eventCount: number;
  /** `prompt.submitted` events — the exact human-turn count, at any file size. */
  turnCount: number;
  /** Agent session ids seen on this session's events, in first-seen order. */
  agentSessionIds: string[];
  /** Harness kind from the session's first event carrying one. */
  harness: HarnessKind | null;
  /** ISO-8601 `ts` of the first / last event seen for the session. */
  firstTs: string | null;
  lastTs: string | null;
}

export interface EventIndex {
  /** Keyed by harnessSessionId. */
  bySession: ReadonlyMap<string, EventIndexEntry>;
  /** agentSessionId → harnessSessionIds that reported it, in first-seen order. */
  byAgentSession: ReadonlyMap<string, readonly string[]>;
}

export interface EventReadFilter {
  /** One or more harnessSessionIds. Index-accelerated: only those byte spans
   *  are read, never the whole file. */
  harnessSessionId?: string | readonly string[];
  /** Keep only these event types. Applied after parsing (the type isn't part
   *  of the index key, so it saves parsing work for the caller, not I/O). */
  types?: readonly AnalyticsEventType[];
}

export interface EventStore {
  /** Append one event as a single ndjson line, serialized through the queue. */
  append(event: AnalyticsEvent): Promise<void>;
  /**
   * Run `fn` exclusively — after all pending appends complete and blocking
   * any new appends until `fn` resolves. Use this to run a retention sweep
   * without racing concurrent writes.
   *
   * A failed `fn` never poisons the queue (later appends proceed normally).
   * The return value of `fn` is forwarded to the caller.
   *
   * The byte-offset index is dropped on entry: a sweep rewrites the file, so
   * every offset it holds is presumed stale.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Stream matching events in file order (= append order, which is only
   * roughly `ts` order; callers needing a strict order sort by `(ts, seq)` —
   * see core/session-record.ts).
   *
   * Runs outside the append queue. Unparseable lines — including a torn final
   * line from a crash mid-append — are skipped, never thrown on. Yields
   * nothing when the file doesn't exist yet.
   */
  read(filter?: EventReadFilter): AsyncIterable<AnalyticsEvent>;
  /**
   * The byte-offset index, built on first call and extended on later ones by
   * scanning only the bytes appended since. Reconciles against the file on
   * every call, so it is always as fresh as the moment it was asked for. Empty
   * when the file doesn't exist.
   */
  index(): Promise<EventIndex>;
}

/** Minimal read surface — what session-record.ts actually needs from a store. */
export type EventReader = Pick<EventStore, "read" | "index">;

interface IndexState {
  bySession: Map<string, EventIndexEntry>;
  byAgentSession: Map<string, string[]>;
  /** Bytes of the file already folded into the index. */
  indexedBytes: number;
  /** Inode of the indexed file — a change means it was replaced (sweep). */
  ino: number;
}

/** Parse one ndjson line into an event, or null when it isn't one. */
function parseEventLine(line: string): AnalyticsEvent | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<AnalyticsEvent>;
  // harnessSessionId keys the index and ts orders the fold — a line missing
  // either can't be placed in a record, so it isn't an event as far as
  // readers are concerned.
  if (typeof candidate.harnessSessionId !== "string") return null;
  if (typeof candidate.ts !== "string" || typeof candidate.type !== "string") return null;
  return candidate as AnalyticsEvent;
}

function matchesFilter(
  event: AnalyticsEvent,
  sessionIds: ReadonlySet<string> | null,
  types: ReadonlySet<AnalyticsEventType> | null,
): boolean {
  if (sessionIds && !sessionIds.has(event.harnessSessionId)) return false;
  if (types && !types.has(event.type)) return false;
  return true;
}

/** Append a span, merging into the previous one when contiguous — keeps a
 *  single-session file at one span instead of one per line. */
function pushSpan(spans: ByteSpan[], start: number, end: number): void {
  const last = spans[spans.length - 1];
  if (last && last.end >= start) {
    last.end = Math.max(last.end, end);
    return;
  }
  spans.push({ start, end });
}

/**
 * @param filePath Defaults to `HARNESS_PATHS.events`
 *   (`~/.sapiom/harness/events.ndjson`). Override in tests.
 */
export function createEventStore(filePath: string = HARNESS_PATHS.events): EventStore {
  const resolvedPath = expandHome(filePath);
  let dirReady: Promise<void> | null = null;

  function ensureDir(): Promise<void> {
    if (!dirReady) {
      dirReady = fs.mkdir(path.dirname(resolvedPath), { recursive: true }).then(() => undefined);
    }
    return dirReady;
  }

  // Promise queue — same pattern as workflow-registry.ts:106-135.
  // Chains each operation so they execute strictly one-at-a-time.
  // A failed run never poisons subsequent operations.
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => {}).then(run);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  /** Line-by-line over `[start, end]` — inclusive `end`, as fs streams take it. */
  async function* readLines(start: number, end: number): AsyncGenerator<string> {
    const stream = createReadStream(resolvedPath, { start, end });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) yield line;
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  /**
   * Line-by-line over a set of byte spans, through ONE file handle and
   * positioned reads.
   *
   * Not `createReadStream` per span, deliberately: a session interleaved with
   * others across the file has one span per contiguous run of its lines —
   * hundreds of them for a busy machine — and standing up a stream plus a
   * readline interface for each costs far more than the bytes do. A span is
   * still read in bounded chunks (never all at once) so a session that owns the
   * whole 50 MB file can't be pulled into memory in one buffer, and a
   * StringDecoder carries multi-byte characters across chunk boundaries.
   */
  async function* readSpanLines(spans: readonly ByteSpan[]): AsyncGenerator<string> {
    if (spans.length === 0) return;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(resolvedPath, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      for (const span of spans) {
        const decoder = new StringDecoder("utf8");
        let carry = "";
        let position = span.start;
        while (position < span.end) {
          const length = Math.min(SPAN_CHUNK_BYTES, span.end - position);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          // A short read means the file shrank under us (a sweep landed
          // mid-read): stop this span rather than looping on a stale offset.
          if (bytesRead <= 0) break;
          position += bytesRead;
          const chunk = carry + decoder.write(buffer.subarray(0, bytesRead));
          const lines = chunk.split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) yield line;
        }
        // Whatever is left has no trailing newline — the file's last line, or
        // a torn one. Either way it's the caller's parser that decides.
        const tail = carry + decoder.end();
        if (tail) yield tail;
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function statFile(): Promise<{ size: number; ino: number } | null> {
    try {
      const stat = await fs.stat(resolvedPath);
      return { size: stat.size, ino: stat.ino };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  // ── Index ───────────────────────────────────────────────────────────────

  let state: IndexState | null = null;
  // Serializes index work so two concurrent reads never scan the same tail
  // twice, nor interleave partial updates into the same maps.
  let indexWork: Promise<unknown> = Promise.resolve();

  function entryFor(current: IndexState, harnessSessionId: string): EventIndexEntry {
    const existing = current.bySession.get(harnessSessionId);
    if (existing) return existing;
    const created: EventIndexEntry = {
      harnessSessionId,
      spans: [],
      eventCount: 0,
      turnCount: 0,
      agentSessionIds: [],
      harness: null,
      firstTs: null,
      lastTs: null,
    };
    current.bySession.set(harnessSessionId, created);
    return created;
  }

  function recordEvent(current: IndexState, event: AnalyticsEvent, start: number, end: number): void {
    const entry = entryFor(current, event.harnessSessionId);
    pushSpan(entry.spans, start, end);
    entry.eventCount += 1;
    if (event.type === "prompt.submitted") entry.turnCount += 1;
    if (entry.harness === null && typeof event.harness === "string") entry.harness = event.harness;
    if (entry.firstTs === null) entry.firstTs = event.ts;
    entry.lastTs = event.ts;
    if (typeof event.agentSessionId === "string" && event.agentSessionId) {
      if (!entry.agentSessionIds.includes(event.agentSessionId)) {
        entry.agentSessionIds.push(event.agentSessionId);
      }
      const siblings = current.byAgentSession.get(event.agentSessionId);
      if (!siblings) {
        current.byAgentSession.set(event.agentSessionId, [event.harnessSessionId]);
      } else if (!siblings.includes(event.harnessSessionId)) {
        siblings.push(event.harnessSessionId);
      }
    }
  }

  /**
   * Fold `[from, to)` of the file into `current`. Offsets advance by the BYTE
   * length of each line, not its character count — a multi-byte prompt would
   * otherwise skew every subsequent span.
   *
   * A final line with no trailing newline (a crash mid-append, or a read that
   * caught an append in flight) rewinds `indexedBytes` to that line's start
   * rather than claiming it as indexed: the next reconcile re-reads it, so a
   * line that was merely incomplete at scan time still lands in the index once
   * it's whole. A line that stays torn forever costs one re-parse per read.
   */
  async function scanInto(current: IndexState, from: number, to: number): Promise<void> {
    if (to <= from) return;
    let offset = from;
    let lastLineStart = from;
    let lastLineWasEvent = false;
    for await (const line of readLines(from, to - 1)) {
      lastLineStart = offset;
      // +1 for the newline readline consumed.
      offset += Buffer.byteLength(line, "utf8") + 1;
      const event = parseEventLine(line);
      lastLineWasEvent = event !== null;
      // min(): the last line may have had no newline to count.
      if (event) recordEvent(current, event, lastLineStart, Math.min(offset, to));
    }
    // `offset > to` means the last line's counted newline wasn't there. Rewind
    // only if that line also failed to parse — a complete final event without a
    // trailing newline is indexed, and re-reading it would double-count it.
    current.indexedBytes = offset > to && !lastLineWasEvent ? lastLineStart : to;
  }

  /**
   * Bring the index in line with the file on disk, building it if needed.
   * Grown file → scan only the new tail. Shrunk file or a new inode → the
   * offsets we hold describe a file that no longer exists (retention sweep),
   * so rebuild. Unchanged → no I/O beyond the stat.
   */
  async function reconcile(): Promise<IndexState> {
    const stat = await statFile();
    if (!stat) {
      // No file yet: an empty index is the honest answer, and it must not be
      // cached as "indexed" — the next call has to look again.
      state = null;
      return { bySession: new Map(), byAgentSession: new Map(), indexedBytes: 0, ino: -1 };
    }

    const current = state;
    if (current && current.ino === stat.ino && stat.size >= current.indexedBytes) {
      if (stat.size > current.indexedBytes) await scanInto(current, current.indexedBytes, stat.size);
      return current;
    }

    const fresh: IndexState = {
      bySession: new Map(),
      byAgentSession: new Map(),
      indexedBytes: 0,
      ino: stat.ino,
    };
    await scanInto(fresh, 0, stat.size);
    state = fresh;
    return fresh;
  }

  /** Serialize reconciliation; concurrent readers queue behind one scan. */
  function withIndex(): Promise<IndexState> {
    const next = indexWork.then(reconcile, reconcile);
    indexWork = next.catch(() => {});
    return next;
  }

  return {
    append(event: AnalyticsEvent): Promise<void> {
      return enqueue(async () => {
        await ensureDir();
        await fs.appendFile(resolvedPath, `${JSON.stringify(event)}\n`, "utf8");
        // The index is deliberately NOT written to here. reconcile() is the one
        // writer, and it absorbs this line by scanning from `indexedBytes` to
        // the current size — the appended bytes only, never the whole file.
        //
        // Writing the entry from this side as well is the obvious optimization
        // and it is wrong: a reader's reconcile() can stat a size that already
        // includes this line while its scan is still in flight, so both paths
        // record the same event and every offset after it shifts by a line. One
        // writer, serialized, no window. The cost is a tail read on the next
        // index() call, which is bounded by what was appended since the last
        // one — a few hundred bytes in practice.
      });
    },

    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      return enqueue(() => {
        // A sweep rewrites the file (temp + rename): every offset the index
        // holds points into the old inode. Drop it and let the next read
        // rebuild, rather than trying to predict what the sweep kept.
        state = null;
        return fn();
      });
    },

    read(filter: EventReadFilter = {}): AsyncIterable<AnalyticsEvent> {
      const requested =
        filter.harnessSessionId === undefined
          ? null
          : typeof filter.harnessSessionId === "string"
            ? [filter.harnessSessionId]
            : [...filter.harnessSessionId];
      const sessionIds = requested ? new Set(requested) : null;
      const types = filter.types ? new Set(filter.types) : null;

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<AnalyticsEvent> {
          if (!requested) {
            // Unfiltered: a full scan IS the answer the caller asked for.
            const stat = await statFile();
            if (!stat || stat.size === 0) return;
            for await (const line of readLines(0, stat.size - 1)) {
              const event = parseEventLine(line);
              if (event && matchesFilter(event, null, types)) yield event;
            }
            return;
          }

          const index = await withIndex();
          // Merge the requested sessions' spans and walk them in file order,
          // so a record spanning several sessions still reads sequentially.
          const collected: ByteSpan[] = [];
          for (const id of requested) {
            const entry = index.bySession.get(id);
            if (entry) collected.push(...entry.spans.map((span) => ({ ...span })));
          }
          collected.sort((a, b) => a.start - b.start);
          const spans: ByteSpan[] = [];
          for (const span of collected) pushSpan(spans, span.start, span.end);

          for await (const line of readSpanLines(spans)) {
            const event = parseEventLine(line);
            if (event && matchesFilter(event, sessionIds, types)) yield event;
          }
        },
      };
    },

    async index(): Promise<EventIndex> {
      const current = await withIndex();
      return { bySession: current.bySession, byAgentSession: current.byAgentSession };
    },
  };
}
