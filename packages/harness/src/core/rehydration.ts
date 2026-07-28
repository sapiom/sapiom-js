/**
 * Portable continue, wiring layer: turns a `rehydrateFrom` id into brief text,
 * and decides which of the two delivery channels carries it.
 *
 * The brief itself is pure (core/resume-brief.ts); this is the part that has to
 * touch the record reader, the summary cache, and the session registry. Kept
 * out of server/index.ts so the resolution order — and the honest "there was
 * nothing recorded for that id" answer — is testable without standing up a
 * server.
 *
 * THE TWO CHANNELS, and why there are two:
 *
 * - `launch-flag` — the brief is composed into the generated system-prompt
 *   file, which claude-code reads via `--append-system-prompt` and codex via
 *   `developer_instructions` (see core/adapters/codex.ts's header for why it
 *   uses that rather than `model_instructions_file`). Both shipped harnesses
 *   use this: no adapter change, no injected keystrokes, and the brief is in
 *   place before the agent's first token.
 * - `post-ready-injection` — the universal fallback for a harness with no
 *   prompt flag at all: wait for the session to report `ready`, then send the
 *   brief through the ordinary input path. It is gated on readiness because
 *   writing into a TUI that is sitting on a "trust this directory?" prompt
 *   feeds the brief to the prompt instead of the agent.
 *
 * No adapter shipped today needs the second channel — which is exactly why it
 * is declared per-adapter rather than inferred: a future adapter that cannot
 * take a prompt flag says so in one line and the context still gets across,
 * instead of being silently dropped.
 */

import type {
  HarnessAdapter,
  SessionRecord,
  SystemPromptDelivery,
} from "../shared/types.js";
import { buildResumeBrief, type ResumeBriefWorkflow } from "./resume-brief.js";

/**
 * How a harness receives a rehydration brief. Absent on the adapter means the
 * fallback, not the flag: an adapter that never wired `systemPromptFile` and
 * never declared anything would otherwise have its brief written to a file
 * nothing reads. Failing toward "delivered noisily" beats failing toward
 * "silently dropped" for a feature whose entire purpose is that the context
 * arrives.
 */
export function systemPromptDeliveryFor(adapter: HarnessAdapter | undefined): SystemPromptDelivery {
  return adapter?.systemPromptDelivery ?? "post-ready-injection";
}

/** Context only the caller can resolve — the record carries no title, no git
 *  branch, and no workflow binding (those live in the session registry and the
 *  workflow registry respectively). */
export interface RehydrationContext {
  title?: string | null;
  gitBranch?: string | null;
  workflow?: ResumeBriefWorkflow | null;
}

export interface RehydrationDeps {
  /** `SessionRecordReader.read` — resolves a harnessSessionId or an agent
   *  session id to the folded record. */
  readRecord: (id: string) => Promise<SessionRecord | null>;
  /** The cached rolling summary for one harness session, or null. */
  readSummary: (harnessSessionId: string) => Promise<string | null>;
  /** Registry-only context for the record. Optional; the brief renders
   *  without it, just less specifically. May be async — the git branch, for
   *  one, is only knowable from an adapter history scan. */
  resolveContext?: (
    record: SessionRecord,
  ) => RehydrationContext | undefined | Promise<RehydrationContext | undefined>;
  /** Token ceiling override, forwarded to `buildResumeBrief`. */
  maxTokens?: number;
}

/**
 * The brief for `rehydrateFrom`, or null when our event log holds nothing for
 * it — the honest answer, and the one that lets a caller say "this continue
 * carried no context" rather than opening a fresh session dressed up as a
 * continuation.
 *
 * Never throws: a rehydration that can't be assembled must degrade to a plain
 * new session, never fail the session-create it is decorating.
 */
export async function buildRehydrationBrief(
  rehydrateFrom: string,
  deps: RehydrationDeps,
): Promise<string | null> {
  const record = await deps.readRecord(rehydrateFrom).catch(() => null);
  if (!record) return null;

  // A conversation can span several harness sessions (a resume, or an adopt),
  // each with its own summary file. Newest-last is the fold that saw the most,
  // so walk backwards and take the first one that exists rather than merging
  // several partial accounts of the same work.
  let summary: string | null = null;
  for (const harnessSessionId of [...record.mergedSessionIds].reverse()) {
    summary = await deps.readSummary(harnessSessionId).catch(() => null);
    if (summary) break;
  }

  const context = (await deps.resolveContext?.(record)) ?? {};
  return buildResumeBrief(record, {
    ...context,
    summary,
    ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
  });
}
