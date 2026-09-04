/**
 * Rebuilds a past session's transcript from OUR OWN recorded events, not from
 * any vendor's transcript file — which is what makes it work identically for
 * claude-code and codex (both normalize into the same AnalyticsEvent stream;
 * see core/collector/normalizer.ts and core/collector/codex-tailer.ts) and
 * makes it survive the vendor deleting, rotating, or never writing its own
 * history.
 *
 * The fold: `prompt.submitted` opens a turn, `tool.call`s attach to the open
 * turn, `turn.completed` closes it with assistantText / model / usage. Events
 * that arrive with no open turn still get a turn of their own (with a null
 * prompt) rather than being dropped — a record whose recording started
 * mid-turn is a real case, and silently discarding those events would show a
 * session as emptier than it was.
 *
 * ORDERING — the one non-obvious rule. `AnalyticsEvent.seq` is NOT a
 * session-lifetime ordering key: it comes from an in-memory per-boot counter
 * (core/collector/seq.ts), so it restarts at 1 on every harness boot and every
 * fresh pty. A real resumed session reads seq 1, 2 then 1, 1, 1. Sorting by
 * `seq` alone would interleave a resume's events into the middle of the first
 * run. Sort by `(ts, seq)`: wall-clock time orders the epochs, and `seq` only
 * breaks ties inside one of them. A restart is a new epoch, never loss.
 *
 * HONESTY — what this can never recover, surfaced as `limitations` on the
 * record so the UI can say it out loud:
 *   - `tool.call` stores a size-capped `toolResponseSummary`; large tool
 *     outputs are gone from our log.
 *   - `turn.completed` carries only the Stop hook's LAST assistant message
 *     (see the header of core/collector/transcript.ts for why), so assistant
 *     narration *between* tool calls is absent. The tool-call stream fills the
 *     chronology, not the prose.
 *   - Codex's rollout has no equivalent of that field at all, so its turns
 *     carry tool calls and prompts but no assistant text.
 *
 * RETENTION — why a record can outlive the events it was folded from. The
 * ndjson is capped at 50 MB / 30 days (collector/store-retention.ts), so a
 * record built only from it would silently disappear a month later. At session
 * end a compacted copy is written to `~/.sapiom/harness/records/` and the
 * reader falls back to it once the log no longer covers the conversation
 * (core/record-archive.ts; the rule is spelled out on `read` below).
 */

import * as os from "node:os";
import * as path from "node:path";

import type {
  AnalyticsEvent,
  HarnessKind,
  SessionRecord,
  SessionRecordLimitation,
  SessionRecordToolCall,
  SessionRecordTurn,
} from "../shared/types.js";
import { projectDirsFor } from "./adapters/claude-code.js";
import { PAYLOAD_TRUNCATION_MARKER } from "./collector/normalizer.js";
import { readLastAssistantTurn } from "./collector/transcript.js";
import type { EventIndex, EventReader } from "./collector/store.js";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsage(value: unknown): SessionRecordTurn["usage"] {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown };
  const inputTokens = numberOrNull(usage.inputTokens);
  const outputTokens = numberOrNull(usage.outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

/**
 * Order events for folding: `ts` first, `seq` only as a tiebreak within the
 * same millisecond. See the module header for why `seq` alone is wrong.
 * Array.prototype.sort is stable, so events matching on both keep file order.
 */
export function sortEventsForFold(
  events: readonly AnalyticsEvent[],
): AnalyticsEvent[] {
  return [...events].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    const seqA = typeof a.seq === "number" ? a.seq : 0;
    const seqB = typeof b.seq === "number" ? b.seq : 0;
    return seqA - seqB;
  });
}

interface OpenTurn {
  prompt: string | null;
  promptAt: string | null;
  toolCalls: SessionRecordToolCall[];
}

export interface FoldOptions {
  /** The id the record is addressed by (the earliest session when several
   *  harness sessions were merged). Defaults to the first event's session. */
  harnessSessionId?: string;
  /** Every harnessSessionId folded in, in first-seen order. Defaults to the
   *  distinct session ids present in `events`. */
  mergedSessionIds?: readonly string[];
  /** Fallback when no event carried a harness kind (an empty record). */
  harness?: HarnessKind;
}

/**
 * Fold an event stream into an ordered {@link SessionRecord}. Pure and
 * synchronous: hand it the events for one session (or for a set of sessions
 * that share an agent session — a resumed conversation) and it returns the
 * transcript. Events for other sessions are tolerated and folded in; the
 * caller is responsible for filtering, which `EventStore.read` does by index.
 */
export function foldSessionRecord(
  events: readonly AnalyticsEvent[],
  options: FoldOptions = {},
): SessionRecord {
  const ordered = sortEventsForFold(events);

  const turns: SessionRecordTurn[] = [];
  let open: OpenTurn | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;
  let harness: HarnessKind | null = options.harness ?? null;
  let agentSessionId: string | null = null;
  const seenSessionIds: string[] = [];

  /** Move the open turn into `turns`, closed by `completion` or incomplete. */
  function close(completion: AnalyticsEvent | null): void {
    if (!open) return;
    const payload = completion?.payload ?? {};
    turns.push({
      index: turns.length + 1,
      prompt: open.prompt,
      promptAt: open.promptAt,
      toolCalls: open.toolCalls,
      assistantText: stringOrNull(payload.assistantText),
      model: stringOrNull(payload.model),
      usage: readUsage(payload.usage),
      completedAt: completion?.ts ?? null,
      incomplete: completion === null,
    });
    open = null;
  }

  for (const event of ordered) {
    if (!seenSessionIds.includes(event.harnessSessionId))
      seenSessionIds.push(event.harnessSessionId);
    if (startedAt === null) startedAt = event.ts;
    if (harness === null && typeof event.harness === "string")
      harness = event.harness;
    if (agentSessionId === null)
      agentSessionId = stringOrNull(event.agentSessionId);
    const payload = event.payload ?? {};

    switch (event.type) {
      case "session.start":
        if (cwd === null) cwd = stringOrNull(payload.cwd);
        break;

      case "prompt.submitted":
        // A prompt arriving while a turn is open means that turn never
        // completed (killed mid-turn, or the user queued another prompt).
        // Keep it, marked incomplete — dropping it would lose real tool calls.
        close(null);
        open = {
          // Project bootstrap control is retained locally for diagnostics but
          // projected as an assistant-initiated turn: its private instruction
          // must never appear as a user message or inflate the human turn count.
          prompt:
            payload.projectBootstrapOrigin === "infrastructure" ||
            payload.plannerOrigin === "infrastructure"
              ? null
              : typeof payload.prompt === "string"
                ? payload.prompt
                : "",
          promptAt:
            payload.projectBootstrapOrigin === "infrastructure" ||
            payload.plannerOrigin === "infrastructure"
              ? null
              : event.ts,
          toolCalls: [],
        };
        break;

      case "tool.call": {
        // No enclosing turn: the recording started mid-turn (a resume attaches
        // its hooks after the prompt was already submitted). Open an anonymous
        // turn so the calls are in the chronology, honestly promptless.
        if (!open) open = { prompt: null, promptAt: null, toolCalls: [] };
        const responseSummary = stringOrNull(payload.toolResponseSummary);
        open.toolCalls.push({
          name: stringOrNull(payload.toolName),
          input: stringOrNull(payload.toolInput),
          responseSummary,
          responseTruncated:
            responseSummary !== null &&
            PAYLOAD_TRUNCATION_MARKER.test(responseSummary),
          at: event.ts,
        });
        break;
      }

      case "turn.completed":
        // A completion with nothing open is an agent-initiated turn (or one
        // whose prompt predates our recording) — give it a promptless turn.
        if (!open) open = { prompt: null, promptAt: null, toolCalls: [] };
        close(event);
        break;

      case "session.end":
        // Never closes the open turn: a session that ended mid-turn HAS an
        // incomplete trailing turn, and that's what the record should say.
        endedAt = event.ts;
        break;

      default:
        // Every other type (UI-interaction analytics: session.switched,
        // macro.invoked, …) is not part of the conversation. Counted in
        // eventCount, deliberately not rendered as a turn.
        break;
    }
  }

  close(null);

  const merged = options.mergedSessionIds
    ? [...options.mergedSessionIds]
    : seenSessionIds;
  return {
    harnessSessionId: options.harnessSessionId ?? merged[0] ?? "",
    mergedSessionIds: merged,
    agentSessionId,
    harness: harness ?? "claude-code",
    cwd,
    startedAt,
    endedAt,
    turns,
    turnCount: turns.filter((turn) => turn.prompt !== null).length,
    eventCount: ordered.length,
    reconstructed: true,
    // Folded from the live log, not read from the archive. The archive is the
    // only thing that sets this (core/record-archive.ts).
    archivedAt: null,
    limitations: computeLimitations(turns),
  };
}

/**
 * Derive the record's honest gaps from the turns themselves.
 *
 * A pure function of the turn list, and called again by the reader after any
 * enrichment — deliberately, because gaps can APPEAR as well as disappear when
 * a turn is filled in. Giving a turn that has tool calls its assistant text
 * back closes `missing-assistant-text` and simultaneously opens
 * `assistant-narration-gap` (only the turn's *final* message was ever
 * recorded). Patching individual codes after the fact got that wrong and
 * under-reported a real gap.
 */
function computeLimitations(
  turns: readonly SessionRecordTurn[],
): SessionRecordLimitation[] {
  const limitations: SessionRecordLimitation[] = [];
  if (
    turns.some((turn) => turn.toolCalls.some((call) => call.responseTruncated))
  ) {
    limitations.push("truncated-tool-output");
  }
  if (
    turns.some(
      (turn) => turn.toolCalls.length > 0 && turn.assistantText !== null,
    )
  ) {
    limitations.push("assistant-narration-gap");
  }
  if (
    turns.some(
      (turn) => turn.completedAt !== null && turn.assistantText === null,
    )
  ) {
    limitations.push("missing-assistant-text");
  }
  if (turns.length > 0 && turns[turns.length - 1].incomplete) {
    limitations.push("incomplete-final-turn");
  }
  return limitations;
}

// ---------------------------------------------------------------------------
// Reader — index-driven lookup over the local event store
// ---------------------------------------------------------------------------

/**
 * Optional last-turn enrichment from a vendor transcript (claude-code only).
 * Strictly an enhancement: it may return null for any reason at all (no file,
 * wrong harness, unreadable) and the record still renders. Never a dependency.
 */
export type FinalTurnEnricher = (record: SessionRecord) => Promise<{
  model: string | null;
  assistantText: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
} | null>;

/**
 * The durable archive, as the reader needs it. Structural on purpose: the real
 * implementation is `createRecordArchive` (core/record-archive.ts), and a test
 * can hand in two functions.
 */
export interface ArchivedRecordSource {
  read(id: string): Promise<SessionRecord | null>;
  list(): Promise<readonly { keys: readonly string[]; turnCount: number }[]>;
}

export interface SessionRecordReader {
  /**
   * The record for `id`, which may be a harnessSessionId or the agent's own
   * session id (history rows the registry never tracked only have the latter).
   * Reads from whichever source still holds the whole conversation — the live
   * event log, or its archived copy once retention has eaten into the log (see
   * {@link createSessionRecordReader} for the rule). Null when neither holds
   * anything for it — the honest answer, and what the route turns into a 404.
   */
  read(id: string): Promise<SessionRecord | null>;
  /**
   * The record folded from the event log ALONE, never from the archive. This is
   * what gets archived (archiving an archive would compact an excerpt of an
   * excerpt and re-stamp it as fresh), and what a caller wanting the
   * uncompacted record while the events are still there should use.
   */
  readFromEvents(id: string): Promise<SessionRecord | null>;
  /**
   * Human-turn counts, keyed by BOTH harnessSessionId and agentSessionId so a
   * history row can be looked up by whichever it has. Exact and cheap at any
   * file size (no transcript scan, no per-row I/O): the event index for
   * conversations the log still holds, the archive's own counts for the rest —
   * so a row's count survives the sweep along with the record it links to.
   */
  turnCounts(): Promise<Map<string, number>>;
  /**
   * Every conversation the event log holds, by primary id, most recently active
   * first. The archive's backfill pass walks this to find conversations that
   * were never archived (see backfillSessionRecords).
   */
  conversationIds(): Promise<string[]>;
}

/**
 * Resolve a requested id to every harnessSessionId whose events belong in its
 * record. A conversation can span several harness sessions (resuming the same
 * agent session id), and the record should be the conversation, not one of its
 * segments. One hop through the agent-session alias map — deliberately not a
 * transitive closure, which could chain unrelated sessions together.
 */
function resolveSessionIds(index: EventIndex, id: string): string[] {
  const ids: string[] = [];
  const add = (candidate: string): void => {
    if (!ids.includes(candidate) && index.bySession.has(candidate))
      ids.push(candidate);
  };

  const direct = index.bySession.get(id);
  if (direct) {
    add(id);
    for (const agentSessionId of direct.agentSessionIds) {
      for (const sibling of index.byAgentSession.get(agentSessionId) ?? [])
        add(sibling);
    }
  } else {
    // Not a harnessSessionId we know — try it as an agent session id.
    for (const sibling of index.byAgentSession.get(id) ?? []) add(sibling);
  }

  // Earliest first, so the record's primary id is where the conversation began.
  return ids.sort((a, b) => {
    const tsA = index.bySession.get(a)?.firstTs ?? "";
    const tsB = index.bySession.get(b)?.firstTs ?? "";
    if (tsA !== tsB) return tsA < tsB ? -1 : 1;
    return a < b ? -1 : 1;
  });
}

/**
 * Reader over the local event store, and — when one is wired in — over the
 * durable record archive that outlives it (core/record-archive.ts). `read`
 * touches only the byte spans the index attributes to the session, so opening a
 * record never rescans the (up to 50 MB) ndjson; see `read`'s own comment for
 * how it chooses between the two sources.
 *
 * MEMORY CEILING — stated, because a global `(ts, seq)` order can't be produced
 * from a stream: `read` holds the whole session's events at once. That is ONE
 * copy, not two — `sortEventsForFold` copies the array of references, and the
 * turns reference the same payload strings the events do. Measured against a
 * 50 MB log owned by a single session at real event density (~4.3 KB/event):
 * 12k events, ~50 MB of record content against ~52 MB on disk (see
 * session-record.perf.test.ts, which asserts that ratio so a regression that
 * duplicates the data or buffers the raw file gets caught).
 *
 * So the ceiling is "one session's share of a file capped at 50 MB", which for
 * the pathological single-session case is ~50 MB of transient heap in a local
 * server. That is deliberate and bounded rather than unbounded; if a future
 * caller needs a tighter bound (H3's rehydration reading only recent context,
 * say), the fix is a `limit`/most-recent-N on the wire, not a change of order.
 */
export function createSessionRecordReader(
  store: EventReader,
  options: {
    enrichFinalTurn?: FinalTurnEnricher;
    archive?: ArchivedRecordSource;
  } = {},
): SessionRecordReader {
  const archive = options.archive;

  const reader: SessionRecordReader = {
    /**
     * SOURCE SELECTION — the one rule worth reading twice.
     *
     * The ticket asked for "prefer the archive when it exists, fall back to
     * scanning events". Taken literally that is wrong in two directions, so
     * this prefers whichever source still holds the WHOLE conversation, which
     * is the archive exactly when the log no longer does:
     *
     * - Preferring the archive for a session that ended a minute ago serves a
     *   compacted excerpt (clipped tool payloads) when the full events are
     *   right there. Scanning them is not the expensive thing it would have
     *   been before H2's byte-offset index — a record open reads only that
     *   session's spans.
     * - A conversation that gets RESUMED keeps writing into the log after its
     *   first archive. "Always prefer the archive" would freeze its record at
     *   the first exit and quietly hide every later turn.
     *
     * The log holds the whole conversation when it still holds the beginning of
     * it: the sweep truncates oldest-first (store-retention.ts), so coverage is
     * always a suffix — an intact first event means nothing in between was
     * dropped. Events newer than the archive mean the conversation continued,
     * which makes the log the fuller source regardless.
     *
     * Neither source → null. A record that was never recorded and one that was
     * swept both answer 404 today; what changed is that far fewer sessions
     * reach that state.
     */
    async read(id: string): Promise<SessionRecord | null> {
      const archived = archive
        ? await archive.read(id).catch(() => null)
        : null;
      if (!archived) return reader.readFromEvents(id);

      const index = await store.index();
      const sessionIds = resolveSessionIds(index, id);
      const entries = sessionIds
        .map((sessionId) => index.bySession.get(sessionId))
        .filter(isPresent);
      const firstTs = earliest(entries.map((entry) => entry.firstTs));
      const lastTs = latest(entries.map((entry) => entry.lastTs));

      const logHoldsTheBeginning =
        firstTs !== null &&
        (archived.startedAt === null || firstTs <= archived.startedAt);
      const logHasNewerEvents =
        lastTs !== null &&
        archived.archivedAt !== null &&
        lastTs > archived.archivedAt;
      if (!logHoldsTheBeginning && !logHasNewerEvents) return archived;
      return (await reader.readFromEvents(id)) ?? archived;
    },

    async readFromEvents(id: string): Promise<SessionRecord | null> {
      const index = await store.index();
      const sessionIds = resolveSessionIds(index, id);
      if (sessionIds.length === 0) return null;

      const events: AnalyticsEvent[] = [];
      for await (const event of store.read({ harnessSessionId: sessionIds }))
        events.push(event);
      if (events.length === 0) return null;

      const record = foldSessionRecord(events, {
        harnessSessionId: sessionIds[0],
        mergedSessionIds: sessionIds,
      });

      if (!options.enrichFinalTurn) return record;
      const final = record.turns[record.turns.length - 1];
      // Only ever fills gaps in the last COMPLETED turn — that is the one the
      // vendor's tail-read can speak to (see readLastAssistantTurn). An
      // incomplete trailing turn is skipped on purpose: the transcript's last
      // assistant message then belongs to some earlier turn, and attaching it
      // here would be a fabrication dressed as an enhancement. Nothing our own
      // events recorded is ever overwritten.
      if (!final || final.completedAt === null) return record;
      if (
        final.assistantText !== null &&
        final.model !== null &&
        final.usage !== null
      )
        return record;
      const enrichment = await options
        .enrichFinalTurn(record)
        .catch(() => null);
      if (!enrichment) return record;
      const enriched: SessionRecordTurn = {
        ...final,
        assistantText: final.assistantText ?? enrichment.assistantText,
        model: final.model ?? enrichment.model,
        usage: final.usage ?? enrichment.usage,
      };
      const turns = [...record.turns.slice(0, -1), enriched];
      // Recomputed, not patched: filling a turn can open a gap as well as close
      // one — see computeLimitations.
      return { ...record, turns, limitations: computeLimitations(turns) };
    },

    async turnCounts(): Promise<Map<string, number>> {
      const index = await store.index();
      const counts = new Map<string, number>();

      // Every key — harness-session and agent-session alike — counts the whole
      // CONVERSATION that `read(id)` would fold for it, not the one segment the
      // index happens to file it under. A conversation resumed under a second
      // harness session must not report two different turn counts depending on
      // which id a history row was keyed by; a row's count has to match the
      // record it links to.
      const totalFor = (id: string): number => {
        let total = 0;
        for (const sessionId of resolveSessionIds(index, id)) {
          total += index.bySession.get(sessionId)?.turnCount ?? 0;
        }
        return total;
      };

      for (const harnessSessionId of index.bySession.keys()) {
        counts.set(harnessSessionId, totalFor(harnessSessionId));
      }
      for (const agentSessionId of index.byAgentSession.keys()) {
        counts.set(agentSessionId, totalFor(agentSessionId));
      }

      // Then the archive, for every key the log can no longer speak for. `max`
      // rather than "fill the gaps": a swept conversation's live count has
      // decayed to a fraction of what happened (or to nothing at all), and a
      // resumed one's live count is the larger, more current number. Taking the
      // greater of the two is right in both directions.
      if (archive) {
        const archived = await archive.list().catch((err: unknown) => {
          console.error("[harness] archived record counts failed:", err);
          return [];
        });
        for (const entry of archived) {
          for (const key of entry.keys) {
            counts.set(key, Math.max(counts.get(key) ?? 0, entry.turnCount));
          }
        }
      }
      return counts;
    },

    async conversationIds(): Promise<string[]> {
      const index = await store.index();
      const primaries = new Map<string, string | null>();
      for (const harnessSessionId of index.bySession.keys()) {
        // resolveSessionIds returns the conversation earliest-first, so its
        // head is the primary id every segment agrees on — which is what
        // dedupes a resumed conversation down to one entry here.
        const [primary] = resolveSessionIds(index, harnessSessionId);
        if (primary === undefined || primaries.has(primary)) continue;
        primaries.set(
          primary,
          latest(
            resolveSessionIds(index, primary).map(
              (id) => index.bySession.get(id)?.lastTs ?? null,
            ),
          ),
        );
      }
      return [...primaries.entries()]
        .sort(([idA, tsA], [idB, tsB]) => {
          if (tsA !== tsB) return (tsB ?? "") < (tsA ?? "") ? -1 : 1;
          return idA < idB ? -1 : 1;
        })
        .map(([id]) => id);
    },
  };

  return reader;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** The smallest / largest non-null ISO timestamp, or null when there is none.
 *  ISO-8601 in UTC sorts lexicographically, which is why these compare strings
 *  rather than parsing dates. */
function earliest(timestamps: readonly (string | null)[]): string | null {
  return timestamps.reduce<string | null>(
    (best, ts) => (ts === null ? best : best === null || ts < best ? ts : best),
    null,
  );
}

function latest(timestamps: readonly (string | null)[]): string | null {
  return timestamps.reduce<string | null>(
    (best, ts) => (ts === null ? best : best === null || ts > best ? ts : best),
    null,
  );
}

/**
 * Fills the LAST turn's model / usage / assistant text from Claude Code's own
 * transcript, when that file happens to still be on disk — a pure enhancement
 * over what our events recorded, wired in via
 * {@link createSessionRecordReader}'s `enrichFinalTurn`.
 *
 * Everything about it is best-effort by design: wrong harness, no cwd, no
 * agent session id, transcript deleted or rotated → null, and the record
 * renders from our events alone. Reuses `readLastAssistantTurn`, so it reads
 * only the tail of a transcript that can be hundreds of MB.
 */
export function createClaudeTranscriptEnricher(
  options: { homeDir?: string } = {},
): FinalTurnEnricher {
  const homeDir = options.homeDir ?? os.homedir();
  return async (record: SessionRecord) => {
    if (record.harness !== "claude-code") return null;
    if (!record.cwd || !record.agentSessionId) return null;
    // projectDirsFor (shared with the adapter's canResume / listPastSessions)
    // handles the trap here: Claude Code stores transcripts under the REALPATH
    // of the project, so a session opened in /tmp/proj lives under
    // `-private-tmp-proj` and a hand-built path silently finds nothing. It
    // returns the resolved candidate first and the raw one as a fallback, so
    // this tries both rather than betting on either.
    for (const projectDir of await projectDirsFor(homeDir, record.cwd)) {
      const turn = await readLastAssistantTurn(
        path.join(projectDir, `${record.agentSessionId}.jsonl`),
      );
      if (turn) return turn;
    }
    return null;
  };
}
