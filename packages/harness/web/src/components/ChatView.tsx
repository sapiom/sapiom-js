/**
 * ChatView — the chat-first center-pane conversation surface.
 *
 * Renders a scrollable turn list (user bubbles, assistant markdown, tool-call
 * chips inline) with the PromptBar composer at the bottom. Designed to feel
 * like a considered conversation window in the style of Conductor/Lovable:
 * calm rhythm, streamed states, tool activity that doesn't crowd the text.
 *
 * Chat events arrive via the EventBus (chat.turn / chat.tool / chat.history).
 * State is per-session — the parent passes a sessionId and the hook handles
 * its own per-session turn list.
 *
 * Scroll behavior:
 *   - Auto-scrolls to the bottom as new turns arrive.
 *   - Locks when the user scrolls up (doesn't hijack their reading position).
 *   - Re-locks (follows) when the user scrolls back to within 60px of the bottom.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type UIEvent } from "react";

import type { ChatToolCall, ChatTurn, HarnessSession } from "@shared/types";

import { Markdown } from "./Markdown";
import { PromptBar } from "./PromptBar";

/** A synthetic system-note row (e.g. "Sent /model to the agent"). */
interface SystemNote {
  id: string;
  text: string;
  /** Cue to switch to the terminal tab, shown as a link in the note. */
  showTerminalLink: boolean;
}

export interface ChatViewProps {
  sessionId: string;
  /** The full HarnessSession object — forwarded to PromptBar for readiness gating. */
  session: HarnessSession | null;
  /** All chat turns for this session, in order. */
  turns: ChatTurn[];
  /** All tool calls for this session, keyed by callId (last status wins). */
  toolCalls: Map<string, ChatToolCall>;
  /** Whether the agent is currently active (no final "stop" event yet). */
  agentWorking: boolean;
  /**
   * Non-empty when the agent is blocked on a permission prompt (Notification
   * hook). Shows a prominent banner with a Terminal tab link. Cleared by:
   *   - the server emitting an empty chat.attention (on PreToolUse / PostToolUse
   *     / Stop / UserPromptSubmit hook events), OR
   *   - any chat.turn or chat.tool arriving for this session (belt-and-braces,
   *     guards against a clearing chat.attention arriving out of order).
   */
  attentionMessage?: string;
  /** Empty-state: no turns yet for this session. */
  onSubmit: (sessionId: string, text: string) => Promise<void>;
  /** Called when the user clicks the "Terminal tab" link in a slash-command note. */
  onSwitchToTerminal?: () => void;
}

/** Heuristic SCROLL_LOCK_THRESHOLD: user is "reading up" if more than 60px from bottom. */
const SCROLL_LOCK_THRESHOLD = 60;


function ToolChip({ call }: { call: ChatToolCall }): JSX.Element {
  const statusClass =
    call.status === "start"
      ? "chat-tool-chip--running"
      : call.status === "error"
        ? "chat-tool-chip--error"
        : "chat-tool-chip--ok";

  return (
    <span className={`chat-tool-chip ${statusClass}`} data-testid={`tool-chip-${call.callId}`}>
      {call.status === "start" && <span className="chat-tool-spinner" aria-hidden="true" />}
      {call.status === "ok" && (
        <svg className="chat-tool-ok-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {call.status === "error" && (
        <svg className="chat-tool-err-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <span className="chat-tool-name">{call.toolName}</span>
    </span>
  );
}

/** Compact label showing the active session's harness kind — passive, non-interactive. */
function HarnessLabel({ harness }: { harness: string }): JSX.Element {
  const label =
    harness === "claude-code" ? "Claude Code"
    : harness === "codex" ? "Codex"
    : harness;
  return (
    <span className="chat-harness-label" data-testid="chat-harness-label" aria-label={`Active harness: ${label}`}>
      {label}
    </span>
  );
}

let systemNoteCounter = 0;

export function ChatView({
  sessionId,
  session,
  turns,
  toolCalls,
  agentWorking,
  attentionMessage,
  onSubmit,
  onSwitchToTerminal,
}: ChatViewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollLocked, setScrollLocked] = useState(false);
  const [systemNotes, setSystemNotes] = useState<SystemNote[]>([]);

  // Reset per-session local state when the active session changes.
  // Do NOT use key={sessionId} at the parent (App.tsx) to remount ChatView —
  // that would also destroy PromptBar's per-session draftsRef which lives
  // below the same key boundary.
  useEffect(() => {
    setScrollLocked(false);
    setSystemNotes([]);
  }, [sessionId]);

  const handleSlashCommand = useCallback((command: string): void => {
    setSystemNotes((prev) => [
      ...prev,
      {
        id: `sn-${++systemNoteCounter}`,
        text: `Sent ${command} to the agent`,
        showTerminalLink: true,
      },
    ]);
  }, []);

  // Auto-scroll: follow the bottom unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollLocked) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, toolCalls, agentWorking, scrollLocked]);

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setScrollLocked(distanceFromBottom > SCROLL_LOCK_THRESHOLD);
  }, []);

  const isEmpty = turns.length === 0;

  return (
    <div className="chat-view" data-testid="chat-view">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="chat-scroll"
        aria-live="polite"
        aria-label="Conversation"
      >
        {isEmpty ? (
          <div className="chat-empty" data-testid="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </div>
            <p className="chat-empty-heading">New conversation</p>
            <p className="chat-empty-hint">Send a message to start working with the agent.</p>
          </div>
        ) : (
          <div className="chat-turns" data-testid="chat-turns">
            {turns.map((turn) => {
              const isUser = turn.role === "user";

              // Collect tool calls that appear "after" this turn and before the next one
              // (in practice: tool calls interleaved between assistant turns).
              // We render all tool calls associated with the session inline in order
              // between turns — tracked by the parent via toolCalls Map.

              return (
                <div
                  key={turn.turnId}
                  className={`chat-turn chat-turn--${turn.role}${turn.streaming ? " chat-turn--streaming" : ""}`}
                  data-testid={`chat-turn-${turn.role}`}
                  data-turn-id={turn.turnId}
                >
                  {!isUser && (
                    <div className="chat-turn-avatar" aria-hidden="true">
                      <svg viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M5 8h6M8 5v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </div>
                  )}
                  <div className="chat-turn-bubble">
                    {isUser ? (
                      <p className="chat-turn-text">{turn.content}</p>
                    ) : (
                      <div className="chat-turn-markdown">
                        {turn.streaming ? (
                          <>
                            <Markdown text={turn.content} />
                            <span className="chat-streaming-cursor" aria-hidden="true" />
                          </>
                        ) : (
                          <Markdown text={turn.content} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Tool chips at the bottom — latest activity */}
            {toolCalls.size > 0 && (
              <div className="chat-tool-row" data-testid="chat-tool-row">
                {Array.from(toolCalls.values()).map((call) => (
                  <ToolChip key={call.callId} call={call} />
                ))}
              </div>
            )}

            {/* System notes (slash commands, status events) */}
            {systemNotes.map((note) => (
              <div key={note.id} className="chat-system-note" data-testid="chat-system-note" role="status">
                <span className="chat-system-note-text">{note.text}</span>
                {note.showTerminalLink && onSwitchToTerminal && (
                  <>
                    {" — "}
                    <button
                      className="chat-system-note-link"
                      data-testid="chat-terminal-link"
                      onClick={onSwitchToTerminal}
                    >
                      Terminal tab
                    </button>
                  </>
                )}
              </div>
            ))}

            {/* Working indicator */}
            {agentWorking && (
              <div className="chat-working" data-testid="chat-working" aria-live="polite">
                <span className="chat-working-dots" aria-label="Agent is working">
                  <span /><span /><span />
                </span>
                <span className="chat-working-label">working…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Jump-to-bottom pill when scroll is locked */}
      {scrollLocked && (
        <button
          className="chat-scroll-to-bottom"
          data-testid="chat-scroll-to-bottom"
          onClick={() => {
            setScrollLocked(false);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          aria-label="Jump to latest message"
        >
          ↓ Latest
        </button>
      )}

      {/* Permission-pending attention banner */}
      {attentionMessage && (
        <div className="chat-attention-banner" data-testid="chat-attention-banner" role="status" aria-live="polite">
          <span className="chat-attention-icon" aria-hidden="true">⚠</span>
          <span className="chat-attention-message">{attentionMessage}</span>
          {onSwitchToTerminal && (
            <>
              {" — "}
              <button
                className="chat-attention-link"
                data-testid="chat-attention-terminal-link"
                onClick={onSwitchToTerminal}
              >
                Review in Terminal
              </button>
            </>
          )}
        </div>
      )}

      {/* Composer (evolved PromptBar) */}
      <div className="chat-composer" data-testid="chat-composer">
        <PromptBar
          session={session}
          onSubmit={onSubmit}
          sessionId={sessionId}
          onSlashCommand={handleSlashCommand}
        />
        <div className="chat-composer-footer">
          {session?.harness ? (
            <HarnessLabel harness={session.harness} />
          ) : (
            <span className="chat-harness-label chat-harness-label--none" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
