/**
 * ConversationPane — the right-region conversation, one slot with an
 * Assistant ⇄ CLI toggle.
 *
 * The Assistant (default) and the CLI are the same kind of thing — a
 * conversation that acts on your agent — so they share this region instead of
 * competing for screen. The Assistant is the zero-setup, Sapiom-run default;
 * the CLI is the user's own Claude Code terminal, opt-in for full-power use.
 *
 *   - Assistant: renders streamed turns (mock stream today; the intelligence
 *     spine after S5). Always mounted so its turns survive a toggle.
 *   - CLI: the existing pty Terminal, unchanged. Lazy-mounted on first reveal
 *     and then kept alive (CSS-hidden) so toggling back doesn't tear down and
 *     re-open the terminal's WebSocket.
 *
 * The toggle mirrors the right pane's segmented switch (see App.tsx) — same
 * markup, classes, and keep-alive discipline — so it reads as one system.
 */
import { useState, type JSX } from "react";

import { useAssistantMockStream } from "../lib/use-assistant-mock-stream";
import { AssistantPane } from "./AssistantPane";
import { Terminal } from "./Terminal";

type ConversationView = "assistant" | "cli";

export interface ConversationPaneProps {
  /** Active session for the CLI terminal; null when no session is live. */
  sessionId: string | null;
  /** Per-boot token the terminal WebSocket upgrade requires. */
  token: string;
}

export function ConversationPane({
  sessionId,
  token,
}: ConversationPaneProps): JSX.Element {
  // Assistant is the zero-setup default (design §6).
  const [view, setView] = useState<ConversationView>("assistant");
  // Track whether the CLI has ever been shown — once true, the Terminal stays
  // mounted (hidden via CSS) so a toggle round-trip never drops its pty socket.
  const [cliEverShown, setCliEverShown] = useState(false);

  const turns = useAssistantMockStream();

  return (
    <div className="conversation-pane" data-testid="conversation-pane">
      <div
        className="conversation-tabs"
        role="tablist"
        aria-label="Conversation"
      >
        <button
          role="tab"
          type="button"
          aria-selected={view === "assistant"}
          className={
            "conversation-tab" + (view === "assistant" ? " is-active" : "")
          }
          onClick={() => setView("assistant")}
          data-testid="conversation-tab-assistant"
        >
          Assistant
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={view === "cli"}
          className={"conversation-tab" + (view === "cli" ? " is-active" : "")}
          onClick={() => {
            setView("cli");
            setCliEverShown(true);
          }}
          data-testid="conversation-tab-cli"
        >
          CLI
        </button>
      </div>

      {/* Assistant: always mounted so streamed turns survive a toggle. */}
      <div
        className={
          "conversation-panel" + (view === "assistant" ? "" : " is-hidden")
        }
        data-testid="conversation-panel-assistant"
      >
        <AssistantPane turns={turns} />
      </div>

      {/* CLI: lazy-mounted on first reveal, then kept alive hidden via CSS. */}
      {(view === "cli" || cliEverShown) && (
        <div
          className={
            "conversation-panel" + (view === "cli" ? "" : " is-hidden")
          }
          data-testid="conversation-panel-cli"
        >
          {sessionId ? (
            <Terminal sessionId={sessionId} token={token} />
          ) : (
            <div
              className="conversation-cli-empty"
              data-testid="conversation-cli-empty"
            >
              No active session — start one to use the CLI.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
