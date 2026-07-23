/**
 * AssistantPane — renders a conversation as streamed turns.
 *
 * Purely presentational: it takes the reduced turns and draws them. The turn
 * source (the mock stream today, the intelligence spine after S5) is owned by
 * the parent, which keeps this component trivial to test and indifferent to
 * where the turns come from. Assistant turns render through the safe-subset
 * Markdown renderer (shared `chat-*` classes); user turns are plain text.
 */
import type { JSX } from "react";

import type { AssistantTurn } from "../lib/assistant-stream";
import { Markdown } from "./Markdown";

export interface AssistantPaneProps {
  turns: AssistantTurn[];
}

export function AssistantPane({ turns }: AssistantPaneProps): JSX.Element {
  return (
    <div className="assistant-pane" data-testid="assistant-pane">
      {turns.length === 0 ? (
        <div className="assistant-empty" data-testid="assistant-empty">
          <p>Ask about the agent you have open.</p>
          <p className="assistant-empty-hint">
            The assistant explains, debugs, runs, and deploys it — no setup, no
            Claude Code required. Switch to CLI for the full builder.
          </p>
        </div>
      ) : (
        <ol className="assistant-turns">
          {turns.map((turn) => (
            <li
              key={turn.id}
              className={`assistant-turn assistant-turn--${turn.role}`}
              data-testid={`assistant-turn-${turn.id}`}
              data-role={turn.role}
              data-status={turn.status}
            >
              <span className="assistant-turn-author">
                {turn.role === "user" ? "You" : "Assistant"}
              </span>
              <div className="assistant-turn-body">
                {turn.role === "assistant" ? (
                  <Markdown text={turn.text} />
                ) : (
                  <p className="chat-paragraph">{turn.text}</p>
                )}
                {turn.status === "streaming" && (
                  <span
                    className="assistant-caret"
                    data-testid="assistant-streaming"
                    aria-label="streaming"
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
