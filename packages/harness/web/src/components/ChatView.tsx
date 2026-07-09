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
   * hook). Shows a prominent banner with a Terminal tab link. Cleared by
   * subsequent hook activity (PostToolUse / Stop / UserPromptSubmit).
   */
  attentionMessage?: string;
  /** Empty-state: no turns yet for this session. */
  onSubmit: (sessionId: string, text: string) => Promise<void>;
  /** Called when the user clicks the "Terminal tab" link in a slash-command note. */
  onSwitchToTerminal?: () => void;
}

/** Heuristic SCROLL_LOCK_THRESHOLD: user is "reading up" if more than 60px from bottom. */
const SCROLL_LOCK_THRESHOLD = 60;

/**
 * Safe subset markdown renderer. Supports:
 *   **bold**, *italic*, `code`, ```code blocks```, # headings, - lists, > blockquotes
 *
 * Implemented without dangerouslySetInnerHTML — builds a React element tree
 * from the markdown string instead.
 */
function renderMarkdown(text: string): JSX.Element {
  const lines = text.split("\n");
  const elements: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  function nextKey(): number {
    return key++;
  }

  function renderInline(line: string): (string | JSX.Element)[] {
    // Handle inline code, bold, italic in sequence
    const parts: (string | JSX.Element)[] = [];
    // Regex: code (`...`), bold (**...**), italic (*...*)
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (match.index > last) {
        parts.push(line.slice(last, match.index));
      }
      const token = match[0];
      if (token.startsWith("`") && token.endsWith("`")) {
        parts.push(<code key={nextKey()} className="chat-inline-code">{token.slice(1, -1)}</code>);
      } else if (token.startsWith("**") && token.endsWith("**")) {
        parts.push(<strong key={nextKey()}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("*") && token.endsWith("*")) {
        parts.push(<em key={nextKey()}>{token.slice(1, -1)}</em>);
      } else {
        parts.push(token);
      }
      last = match.index + token.length;
    }
    if (last < line.length) {
      parts.push(line.slice(last));
    }
    return parts;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      elements.push(
        <pre key={nextKey()} className="chat-code-block" data-lang={lang || undefined}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const Tag = (`h${level}`) as "h1" | "h2" | "h3";
      elements.push(
        <Tag key={nextKey()} className="chat-heading">
          {renderInline(headingMatch[2])}
        </Tag>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      elements.push(
        <blockquote key={nextKey()} className="chat-blockquote">
          {renderInline(line.slice(2))}
        </blockquote>,
      );
      i++;
      continue;
    }

    // List items
    if (line.match(/^[-*+]\s+/)) {
      const listItems: JSX.Element[] = [];
      while (i < lines.length && lines[i].match(/^[-*+]\s+/)) {
        const itemText = lines[i].replace(/^[-*+]\s+/, "");
        listItems.push(<li key={nextKey()}>{renderInline(itemText)}</li>);
        i++;
      }
      elements.push(<ul key={nextKey()} className="chat-list">{listItems}</ul>);
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    elements.push(
      <p key={nextKey()} className="chat-paragraph">
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  return <>{elements}</>;
}

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
                            {renderMarkdown(turn.content)}
                            <span className="chat-streaming-cursor" aria-hidden="true" />
                          </>
                        ) : (
                          renderMarkdown(turn.content)
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
