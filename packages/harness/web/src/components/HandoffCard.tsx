import { createContext, useContext, useState } from "react";
import type { JSX } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

import { handoffArgs, type HandoffArgs } from "../lib/map-chat-host";
import { Icon } from "./Icon";

/**
 * What a hand-off card can do, given by the project view (design-map-chat.md
 * §4.4 step 4). The card sits deep inside the map chat's message tree, so the
 * callbacks arrive by context rather than through the chat's props.
 */
export interface HandoffActions {
  /** The session this card already made, or null. */
  sessionFor: (callId: string) => string | null;
  /** Start session: a new terminal session at the project root, NOT selected
   *  (I6). Resolves to its id, or null when it could not be made. */
  start: (callId: string, args: HandoffArgs) => Promise<string | null>;
  /** Open session: the one navigation the card makes, on the user's word. */
  open: (sessionId: string) => void;
}

export const HandoffContext = createContext<HandoffActions | null>(null);

/**
 * THE HAND-OFF CARD (flow-map-chat-overlay.md 4.3.6): the map chat's answer
 * when the work belongs in a session. A title, the prompt the chat wrote for
 * that job, and Start session. Starting it makes the session and leaves the
 * user where they are, on the map with the chat open; the card then offers
 * Open session, which is the only way it navigates.
 *
 * Rendered for the `handoff` tool part (`tools.by_name`); it waits for both
 * arguments, so a streaming call never shows half a prompt as a task.
 */
export function HandoffCard({
  toolCallId,
  args,
}: ToolCallMessagePartProps): JSX.Element | null {
  const actions = useContext(HandoffContext);
  const [starting, setStarting] = useState(false);
  const handoff = handoffArgs(args);
  if (!handoff) return null;
  const session = actions?.sessionFor(toolCallId) ?? null;
  return (
    <div
      className="chat-handoff"
      data-testid="chat-card-handoff"
      data-session={session ?? undefined}
    >
      <p className="chat-handoff-title">
        <Icon name="SquareTerminal" size={14} />
        <span>{handoff.title}</span>
      </p>
      <pre className="chat-handoff-prompt" data-testid="chat-handoff-prompt">
        {handoff.prompt}
      </pre>
      {session ? (
        <button
          type="button"
          className="btn-line chat-handoff-action"
          data-testid="chat-handoff-open"
          onClick={() => actions?.open(session)}
        >
          Open session <Icon name="ArrowRight" size={12} />
        </button>
      ) : (
        <button
          type="button"
          className="btn-primary chat-handoff-action"
          data-testid="chat-handoff-start"
          disabled={!actions || starting}
          aria-busy={starting || undefined}
          onClick={() => {
            if (!actions) return;
            setStarting(true);
            void actions
              .start(toolCallId, handoff)
              .finally(() => setStarting(false));
          }}
        >
          Start session
        </button>
      )}
    </div>
  );
}
