import { useState } from "react";
import type { JSX, ReactNode } from "react";
import type { WorkflowInfo } from "@shared/types";

import { askPlaceholder, type AskSubject } from "../lib/map-ask";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { Icon } from "./Icon";

/**
 * THE MAP'S FLOATING CARD (flow-map-chat-overlay.md 4.1 to 4.3; mock
 * design-eng `agent-studio-v2/src/components/MapCard.tsx`). It floats over the
 * map's bottom-right and never takes width from it (I1), in three states:
 *
 *  - project: one composer, "Ask about this project" (4.1.2);
 *  - node: ONE header row, the pick's name, Deployed or Draft, and two icon
 *    buttons, Open agent (↗, the modal, 4.2b) and Open in Finder (named for
 *    the OS); then the composer, "Ask about <name>" (4.2.1). A resource or a
 *    step gets the header row without the buttons (4.2.3);
 *  - chat: the project's map chat (4.3.3), with New chat, Open in session and
 *    × (back to the card, keeping the conversation). Stop is the chat
 *    composer's own send button while a reply streams.
 *
 * Typing is asking: no Start chat, no `⋯`, no Sessions list (the rail has
 * them) and no Change location (4.2.2).
 */
export function MapCard({
  projectLabel,
  subject,
  agent,
  chat,
  canAsk,
  revealLabel,
  onAsk,
  onOpenAgent,
  onReveal,
}: {
  projectLabel: string;
  /** What the card is about: the pick, else the project itself. */
  subject: AskSubject;
  /** The picked agent, when the pick is one. */
  agent: WorkflowInfo | null;
  /** The map chat, while it is open: its pane and its three header verbs. */
  chat: {
    pane: ReactNode;
    onNewChat: () => void;
    onOpenInSession: () => void;
    onClose: () => void;
  } | null;
  /** The Assistant is available to this account; without it the card names
   *  the pick and offers no composer. */
  canAsk: boolean;
  /** "Open in Finder", "Show in Explorer" or "Open folder" (lib/desktop). */
  revealLabel: string;
  onAsk: (question: string) => void;
  onOpenAgent: (agent: WorkflowInfo) => void;
  onReveal: (agent: WorkflowInfo) => void;
}): JSX.Element | null {
  const picked = subject.kind !== "project";
  const state = chat ? "chat" : picked ? "node" : "project";
  // Nothing to show at rest without a composer: the map is the whole view.
  if (!chat && !picked && !canAsk) return null;

  return (
    <div
      className={"map-card" + (chat ? " map-card--chat" : "")}
      data-testid="map-card"
      data-state={state}
      data-subject={subject.name}
      data-kind={subject.kind}
      role="complementary"
      aria-label={chat ? `Map chat, ${projectLabel}` : subject.name}
      {...trackingAttrs({ surface: "map_card" })}
    >
      {chat ? (
        <>
          <div className="map-card-head">
            <Icon name="MessageSquare" size={14} />
            <span className="map-card-title" data-testid="map-chat-title">
              Map chat
            </span>
            <span className="map-card-head-verbs">
              <button
                type="button"
                className="theme-toggle"
                data-testid="map-chat-new"
                aria-label="New chat"
                data-tooltip="New chat"
                onClick={chat.onNewChat}
              >
                <Icon name="Plus" size={14} />
              </button>
              <button
                type="button"
                className="theme-toggle"
                data-testid="map-chat-open-in-session"
                aria-label="Open in session"
                data-tooltip="Open in session"
                onClick={chat.onOpenInSession}
              >
                <Icon name="SquareTerminal" size={14} />
              </button>
              <button
                type="button"
                className="theme-toggle"
                data-testid="map-chat-close"
                aria-label="Close chat"
                data-tooltip="Close"
                onClick={chat.onClose}
              >
                <Icon name="X" size={14} />
              </button>
            </span>
          </div>
          <div className="map-chat-overlay" data-testid="map-chat-overlay">
            {chat.pane}
          </div>
        </>
      ) : (
        <>
          {picked && (
            <div className="map-card-head">
              <Icon
                name={
                  agent
                    ? "Zap"
                    : subject.kind === "resource"
                      ? "Database"
                      : "Workflow"
                }
                size={14}
              />
              <span
                className="map-card-title"
                data-testid="map-card-name"
                data-tooltip={agent?.path}
              >
                {subject.name}
              </span>
              <span className="map-card-state" data-testid="map-card-state">
                {agent
                  ? agent.definitionId != null
                    ? "Deployed"
                    : "Draft"
                  : subject.kind}
              </span>
              {agent && (
                <span className="map-card-head-verbs">
                  <button
                    type="button"
                    className="theme-toggle"
                    data-testid="map-card-open-agent"
                    aria-label={`Open ${agent.name}`}
                    data-tooltip="Open agent"
                    onClick={() => onOpenAgent(agent)}
                  >
                    {/* ↗, the map's own node enter arrow, so the card and
                        the board say "open this agent" alike (rev 4.1). */}
                    <Icon name="ArrowUpRight" size={14} />
                  </button>
                  <button
                    type="button"
                    className="theme-toggle"
                    data-testid="map-card-reveal"
                    aria-label={`${revealLabel}: ${agent.name}`}
                    data-tooltip={revealLabel}
                    onClick={() => onReveal(agent)}
                  >
                    <Icon name="FolderOpen" size={14} />
                  </button>
                </span>
              )}
            </div>
          )}
          {canAsk && (
            <MapAskComposer
              key={`ask:${subject.path}`}
              placeholder={askPlaceholder(subject)}
              onSubmit={onAsk}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The card's composer while the map chat is closed. Enter hands the question
 * to the project view, which opens the map chat and sends it there; the draft
 * belongs to this pick, so a different pick starts empty.
 */
function MapAskComposer({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (question: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const submit = (): void => {
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    onSubmit(question);
  };
  return (
    <form
      className="map-card-composer"
      data-testid="map-card-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="map-card-input"
        data-testid="chat-input"
        aria-label={placeholder}
        placeholder={placeholder}
        rows={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="map-card-composer-row">
        <button
          type="submit"
          className="composer-send"
          data-testid="chat-submit"
          aria-label="Ask"
          disabled={draft.trim() === ""}
        >
          <Icon name="ArrowUp" size={14} />
        </button>
      </div>
    </form>
  );
}
