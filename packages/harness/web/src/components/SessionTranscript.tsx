import type { JSX } from "react";
import type { SessionRecord, SessionRecordToolCall, SessionRecordTurn } from "@shared/types";

import { Markdown } from "./Markdown";
import { describeLimitations, formatClockTime, formatUsage, toolCallLabel } from "../lib/session-record-view";

/**
 * Read-only transcript of a past session, turn by turn.
 *
 * The source is the harness's OWN recorded events (see
 * src/core/session-record.ts), not the agent's transcript file — which is why
 * it renders identically for Claude Code and Codex, and why it still works
 * after the vendor's history is deleted.
 *
 * Because of that source, it is a RECONSTRUCTION, and this component says so
 * where the user reads it: a "Reconstructed" label, the specific gaps the
 * server reported (`record.limitations`), and — per turn — no invented content
 * anywhere. A turn with no recorded prompt says exactly that; a truncated tool
 * result is marked truncated; a turn that never completed is marked as such.
 *
 * A record whose events have aged out of the local log comes from its archived
 * copy (`record.archivedAt` set — see src/core/record-archive.ts), which is
 * bounded and therefore lossier still. That, too, is stated here rather than
 * left for the user to infer from a session that reads thinner than they
 * remember.
 */
export function SessionTranscript({ record }: { record: SessionRecord }): JSX.Element {
  const notes = describeLimitations(record.limitations);
  const archivedAt = formatClockTime(record.archivedAt);

  return (
    <div className="transcript" data-testid="session-transcript">
      <div className="transcript-notice" data-testid="transcript-reconstructed">
        <span className="transcript-badge">Reconstructed</span>
        <div className="transcript-notice-body">
          <p className="transcript-notice-lead">
            Rebuilt from the harness's own recording of this session, not a replay of your terminal.
          </p>
          {record.archivedAt !== null && (
            <p
              className="transcript-notice-lead transcript-notice-archived"
              data-testid="transcript-archived"
            >
              {archivedAt
                ? `Archived copy from ${archivedAt}, kept after this session's raw events aged out of the local log.`
                : "Archived copy, kept after this session's raw events aged out of the local log."}
            </p>
          )}
          {notes.length > 0 && (
            <ul className="transcript-notice-list" data-testid="transcript-limitations">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ol className="transcript-turns">
        {record.turns.map((turn) => (
          <TranscriptTurn key={turn.index} turn={turn} />
        ))}
      </ol>
    </div>
  );
}

function TranscriptTurn({ turn }: { turn: SessionRecordTurn }): JSX.Element {
  const usage = formatUsage(turn.usage);
  const promptAt = formatClockTime(turn.promptAt);

  return (
    <li className="transcript-turn" data-testid="transcript-turn" data-turn={turn.index}>
      <div className="transcript-role transcript-role-user">
        <span className="transcript-role-label">You</span>
        {promptAt && <span className="transcript-time">{promptAt}</span>}
      </div>
      {turn.prompt !== null ? (
        <div className="transcript-prompt" data-testid="transcript-prompt">
          {turn.prompt}
        </div>
      ) : (
        <div className="transcript-absent" data-testid="transcript-no-prompt">
          No prompt recorded for this turn — the harness started recording after it began.
        </div>
      )}

      {turn.toolCalls.length > 0 && (
        <ul className="transcript-tools" data-testid="transcript-tools">
          {turn.toolCalls.map((call, index) => (
            <TranscriptToolCall key={`${call.at}-${index}`} call={call} />
          ))}
        </ul>
      )}

      <div className="transcript-role transcript-role-agent">
        <span className="transcript-role-label">Agent</span>
        {turn.model && <span className="transcript-model">{turn.model}</span>}
        {usage && <span className="transcript-usage">{usage}</span>}
      </div>
      {turn.assistantText !== null ? (
        <div className="transcript-assistant" data-testid="transcript-assistant">
          <Markdown text={turn.assistantText} />
        </div>
      ) : (
        <div className="transcript-absent" data-testid="transcript-no-assistant">
          {turn.incomplete
            ? "This turn never completed — no reply was recorded."
            : "No assistant text was recorded for this turn."}
        </div>
      )}

      {turn.incomplete && (
        <div className="transcript-incomplete" data-testid="transcript-incomplete">
          Turn incomplete
        </div>
      )}
    </li>
  );
}

/**
 * One tool call, collapsed by default — a long session is mostly tool traffic,
 * and the conversation is what the pane is for. Expanding shows the full stored
 * input and result, with the truncation stated when the recording capped it.
 */
function TranscriptToolCall({ call }: { call: SessionRecordToolCall }): JSX.Element {
  return (
    <li className="transcript-tool">
      <details data-testid="transcript-tool-call">
        <summary className="transcript-tool-summary">
          <span className="transcript-tool-name">{toolCallLabel(call.name, call.input)}</span>
          {call.responseTruncated && (
            <span className="transcript-tool-truncated" data-testid="transcript-tool-truncated">
              truncated
            </span>
          )}
        </summary>
        <div className="transcript-tool-body">
          {call.input && (
            <>
              <div className="transcript-tool-heading">Input</div>
              <pre className="transcript-tool-pre">{call.input}</pre>
            </>
          )}
          <div className="transcript-tool-heading">Result</div>
          {call.responseSummary ? (
            <pre className="transcript-tool-pre">{call.responseSummary}</pre>
          ) : (
            <div className="transcript-absent">No result recorded.</div>
          )}
          {call.responseTruncated && (
            <div className="transcript-absent">
              The recorded result was truncated at the collector's size cap; the rest isn't recoverable.
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
