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
import { encodeProjectPath } from "./adapters/claude-code.js";
import { readLastAssistantTurn } from "./collector/transcript.js";
import type { EventIndex, EventReader } from "./collector/store.js";

/** The suffix `truncateForPayload` (core/collector/normalizer.ts) leaves behind. */
const TRUNCATION_MARKER = /…\[truncated \d+ chars\]$/;

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
export function sortEventsForFold(events: readonly AnalyticsEvent[]): AnalyticsEvent[] {
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
    if (!seenSessionIds.includes(event.harnessSessionId)) seenSessionIds.push(event.harnessSessionId);
    if (startedAt === null) startedAt = event.ts;
    if (harness === null && typeof event.harness === "string") harness = event.harness;
    if (agentSessionId === null) agentSessionId = stringOrNull(event.agentSessionId);
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
          prompt: typeof payload.prompt === "string" ? payload.prompt : "",
          promptAt: event.ts,
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
          responseTruncated: responseSummary !== null && TRUNCATION_MARKER.test(responseSummary),
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

  const limitations: SessionRecordLimitation[] = [];
  if (turns.some((turn) => turn.toolCalls.some((call) => call.responseTruncated))) {
    limitations.push("truncated-tool-output");
  }
  if (turns.some((turn) => turn.toolCalls.length > 0 && turn.assistantText !== null)) {
    limitations.push("assistant-narration-gap");
  }
  if (turns.some((turn) => turn.completedAt !== null && turn.assistantText === null)) {
    limitations.push("missing-assistant-text");
  }
  if (turns.length > 0 && turns[turns.length - 1].incomplete) {
    limitations.push("incomplete-final-turn");
  }

  const merged = options.mergedSessionIds ? [...options.mergedSessionIds] : seenSessionIds;
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
    limitations,
  };
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

export interface SessionRecordReader {
  /**
   * The record for `id`, which may be a harnessSessionId or the agent's own
   * session id (history rows the registry never tracked only have the latter).
   * Null when our event log holds nothing for it — the honest answer, and
   * what the route turns into a 404.
   */
  read(id: string): Promise<SessionRecord | null>;
  /**
   * Exact human-turn counts from the index, keyed by BOTH harnessSessionId and
   * agentSessionId so a history row can be looked up by whichever it has.
   * Cheap at any file size (no transcript scan, no per-row I/O).
   */
  turnCounts(): Promise<Map<string, number>>;
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
    if (!ids.includes(candidate) && index.bySession.has(candidate)) ids.push(candidate);
  };

  const direct = index.bySession.get(id);
  if (direct) {
    add(id);
    for (const agentSessionId of direct.agentSessionIds) {
      for (const sibling of index.byAgentSession.get(agentSessionId) ?? []) add(sibling);
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
 * Reader over the local event store. `read` touches only the byte spans the
 * index attributes to the session, so opening a record never rescans the (up
 * to 50 MB) ndjson.
 */
export function createSessionRecordReader(
  store: EventReader,
  options: { enrichFinalTurn?: FinalTurnEnricher } = {},
): SessionRecordReader {
  return {
    async read(id: string): Promise<SessionRecord | null> {
      const index = await store.index();
      const sessionIds = resolveSessionIds(index, id);
      if (sessionIds.length === 0) return null;

      const events: AnalyticsEvent[] = [];
      for await (const event of store.read({ harnessSessionId: sessionIds })) events.push(event);
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
      if (final.assistantText !== null && final.model !== null && final.usage !== null) return record;
      const enrichment = await options.enrichFinalTurn(record).catch(() => null);
      if (!enrichment) return record;
      const enriched: SessionRecordTurn = {
        ...final,
        assistantText: final.assistantText ?? enrichment.assistantText,
        model: final.model ?? enrichment.model,
        usage: final.usage ?? enrichment.usage,
      };
      const turns = [...record.turns.slice(0, -1), enriched];
      return {
        ...record,
        turns,
        // The enrichment may have filled the very gap we flagged.
        limitations: turns.some((turn) => turn.completedAt !== null && turn.assistantText === null)
          ? record.limitations
          : record.limitations.filter((limitation) => limitation !== "missing-assistant-text"),
      };
    },

    async turnCounts(): Promise<Map<string, number>> {
      const index = await store.index();
      const counts = new Map<string, number>();
      for (const entry of index.bySession.values()) {
        counts.set(entry.harnessSessionId, entry.turnCount);
      }
      // Agent-session keys sum every harness session that reported them, so a
      // conversation resumed under a new harness session still counts once,
      // whole — matching what `read` folds for the same id.
      for (const [agentSessionId, harnessSessionIds] of index.byAgentSession) {
        let total = 0;
        for (const harnessSessionId of harnessSessionIds) {
          total += index.bySession.get(harnessSessionId)?.turnCount ?? 0;
        }
        counts.set(agentSessionId, total);
      }
      return counts;
    },
  };
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
    const transcriptPath = path.join(
      homeDir,
      ".claude",
      "projects",
      encodeProjectPath(record.cwd),
      `${record.agentSessionId}.jsonl`,
    );
    return readLastAssistantTurn(transcriptPath);
  };
}
