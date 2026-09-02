import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX, KeyboardEvent } from "react";
import type {
  PlannerGreetingState,
  PlannerSessionMetadata,
} from "@shared/agent-map";
import type { SessionRecord, SessionRecordTurn } from "@shared/types";

import type { SessionRecordState } from "../lib/use-session-record";
import { formatClockTime, toolCallLabel } from "../lib/session-record-view";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

interface PlanningConversationPaneProps {
  metadata: PlannerSessionMetadata;
  transcript: SessionRecordState;
  onRetryTranscript: () => void;
  onSend: (text: string) => Promise<void>;
  onRetryGreeting: () => Promise<void>;
  disabled?: boolean;
}

function hasUserProceeded(
  greeting: PlannerGreetingState,
  metadata: PlannerSessionMetadata,
  transcript: SessionRecordState,
): boolean {
  if (greeting.status === "skipped" || metadata.queuedInputIds.length > 0) {
    return true;
  }
  return (
    transcript.status === "ready" &&
    transcript.record.turns.some((turn) => turn.prompt !== null)
  );
}

function GreetingStatus({
  metadata,
  transcript,
  retrying,
  onRetry,
}: {
  metadata: PlannerSessionMetadata;
  transcript: SessionRecordState;
  retrying: boolean;
  onRetry: () => void;
}): JSX.Element | null {
  const greeting = metadata.greeting;
  if (greeting.status === "pending" || greeting.status === "generating") {
    return (
      <div
        className="planner-inline-status"
        data-testid="planner-greeting-generating"
        role="status"
      >
        <span className="session-busy" aria-hidden="true" />
        The planning agent is getting ready&hellip;
      </div>
    );
  }
  if (greeting.status !== "failed") return null;
  const canRetry =
    greeting.retryable &&
    (transcript.status === "empty" || transcript.status === "ready") &&
    !hasUserProceeded(greeting, metadata, transcript) &&
    !retrying;
  return (
    <div
      className="planner-inline-status is-error"
      data-testid="planner-greeting-failed"
      role="alert"
    >
      <Icon name="TriangleAlert" size={14} />
      <span>
        The automatic greeting did not arrive. You can keep planning below.
      </span>
      {canRetry && (
        <button
          type="button"
          className="btn-secondary planner-inline-retry"
          data-testid="planner-greeting-retry"
          onClick={onRetry}
        >
          Retry greeting
        </button>
      )}
    </div>
  );
}

/**
 * Planner-only projection of SessionRecord.
 *
 * A null prompt is the private assistant-initiated greeting control turn, so
 * it renders only the assistant response — never a fabricated "You" row.
 * Tool traffic is kept behind one collapsed disclosure so the conversation is
 * the primary surface without pretending the calls did not happen.
 */
export function PlanningTranscript({
  record,
}: {
  record: SessionRecord;
}): JSX.Element {
  return (
    <ol
      className="transcript-turns planner-transcript-turns"
      data-testid="planner-transcript"
    >
      {record.turns.map((turn) => (
        <PlanningTurn key={turn.index} turn={turn} />
      ))}
    </ol>
  );
}

function PlanningTurn({ turn }: { turn: SessionRecordTurn }): JSX.Element {
  const promptAt = formatClockTime(turn.promptAt);
  return (
    <li
      className="transcript-turn planner-transcript-turn"
      data-testid="planner-transcript-turn"
      data-turn={turn.index}
    >
      {turn.prompt !== null && (
        <>
          <div className="transcript-role transcript-role-user">
            <span className="transcript-role-label">You</span>
            {promptAt && <span className="transcript-time">{promptAt}</span>}
          </div>
          <div
            className="transcript-prompt"
            data-testid="planner-transcript-prompt"
          >
            {turn.prompt}
          </div>
        </>
      )}

      {turn.toolCalls.length > 0 && (
        <details
          className="planner-tool-calls"
          data-testid="planner-tool-calls"
        >
          <summary>
            {turn.toolCalls.length === 1
              ? "1 planning action"
              : `${turn.toolCalls.length} planning actions`}
          </summary>
          <ul>
            {turn.toolCalls.map((call, index) => (
              <li key={`${call.at}-${index}`}>
                {toolCallLabel(call.name, call.input)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {turn.assistantText !== null ? (
        <>
          <div className="transcript-role transcript-role-agent">
            <span className="transcript-role-label">Planner</span>
          </div>
          <div
            className="transcript-assistant"
            data-testid="planner-transcript-assistant"
          >
            <Markdown text={turn.assistantText} />
          </div>
        </>
      ) : turn.incomplete ? (
        <div className="planner-inline-status" role="status">
          <span className="session-busy" aria-hidden="true" />
          The planning agent is working&hellip;
        </div>
      ) : null}
    </li>
  );
}

export function PlanningConversationPane({
  metadata,
  transcript,
  onRetryTranscript,
  onSend,
  onRetryGreeting,
  disabled = false,
}: PlanningConversationPaneProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [retryingGreeting, setRetryingGreeting] = useState(false);
  const [greetingRetryError, setGreetingRetryError] = useState<string | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const turnCount =
    transcript.status === "ready" ? transcript.record.turns.length : 0;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const distanceFromBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    if (distanceFromBottom < 160) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [turnCount, metadata.queuedInputIds.length, metadata.greeting.status]);

  useEffect(() => {
    if (metadata.greeting.status !== "failed") {
      setGreetingRetryError(null);
    }
  }, [metadata.greeting.status]);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(text);
      // The composer remains editable while the request is in flight. Do not
      // erase text the user started typing for their next message.
      setDraft((current) => (current === submittedDraft ? "" : current));
      inputRef.current?.focus();
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : "The message could not be queued.",
      );
    } finally {
      setSending(false);
    }
  };

  const retryGreeting = async (): Promise<void> => {
    if (retryingGreeting) return;
    setRetryingGreeting(true);
    setGreetingRetryError(null);
    try {
      await onRetryGreeting();
    } catch (error) {
      setGreetingRetryError(
        error instanceof Error
          ? error.message
          : "The greeting could not be retried.",
      );
    } finally {
      setRetryingGreeting(false);
    }
  };

  const onComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    void submit();
  };

  return (
    <div className="planning-conversation" data-testid="planning-conversation">
      <div
        ref={scrollRef}
        className="planner-transcript-scroll"
        role="log"
        aria-live="polite"
        aria-label="Planning conversation"
      >
        {transcript.status === "loading" ? (
          <div className="planner-inline-status" role="status">
            <span className="session-busy" aria-hidden="true" />
            Loading planning conversation&hellip;
          </div>
        ) : transcript.status === "error" ? (
          <div
            className="planner-transcript-error"
            data-testid="planner-transcript-error"
            role="alert"
          >
            <span>Conversation history could not be loaded.</span>
            <button
              type="button"
              className="btn-secondary"
              onClick={onRetryTranscript}
            >
              Retry history
            </button>
          </div>
        ) : transcript.status === "ready" ? (
          <PlanningTranscript record={transcript.record} />
        ) : null}

        <GreetingStatus
          metadata={metadata}
          transcript={transcript}
          retrying={retryingGreeting}
          onRetry={() => void retryGreeting()}
        />

        {greetingRetryError && (
          <div
            className="planner-inline-status is-error"
            data-testid="planner-greeting-retry-error"
            role="alert"
          >
            <Icon name="TriangleAlert" size={14} />
            <span>{greetingRetryError}</span>
          </div>
        )}

        {metadata.queuedInputIds.length > 0 && (
          <div
            className="planner-inline-status"
            data-testid="planner-queued-inputs"
            role="status"
          >
            <span className="session-busy" aria-hidden="true" />
            {metadata.queuedInputIds.length === 1
              ? "Message queued"
              : `${metadata.queuedInputIds.length} messages queued`}
          </div>
        )}
      </div>

      <form
        className="planner-composer"
        onSubmit={(event) => void submit(event)}
      >
        <div className="composer-box">
          <textarea
            ref={inputRef}
            className="composer-input planner-composer-input"
            data-testid="planner-composer-input"
            aria-label="Message the planning agent"
            placeholder="Describe what you want to build…"
            value={draft}
            maxLength={100_000}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="composer-box-actions">
            {sendError && (
              <span
                className="planner-send-error"
                data-testid="planner-send-error"
                role="alert"
              >
                {sendError}
              </span>
            )}
            <div className="composer-box-right">
              <button
                type="submit"
                className="composer-send"
                data-testid="planner-composer-send"
                aria-label="Send message"
                disabled={disabled || sending || !draft.trim()}
              >
                {sending ? (
                  <span className="session-busy" aria-hidden="true" />
                ) : (
                  <Icon name="ArrowUp" size={15} />
                )}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
