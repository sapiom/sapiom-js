import { useEffect, useMemo, type ReactNode } from "react";
import {
  OpenCodeChat,
  type ChatDraft,
  type ChatDraftStore,
} from "./OpenCodeChat";
import type { ConversationMode } from "./SessionView";

/**
 * A session's conversation body: its terminal, or its Assistant chat when the
 * header's switch says so. Eligibility is the server's, pushed as
 * `assistant.state`.
 */
export function AssistantPane({
  sessionId,
  bootToken,
  enabled,
  mode,
  onModeChange,
  onTerminalReveal,
  terminalRevision,
  drafts,
  authorityRevision,
  onSignIn,
  onOpenSettings,
  children,
}: {
  sessionId: string;
  bootToken: string;
  enabled: boolean;
  mode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
  /** Handled by the shell, which outlives this pane, so a remount replays nothing. */
  onTerminalReveal: (sessionId: string, revision: number) => void;
  terminalRevision: number;
  drafts: ChatDraftStore;
  authorityRevision: string | null;
  onSignIn: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
}) {
  const draft = useMemo(() => {
    const entry = drafts.get(sessionId) ?? { text: "" };
    drafts.set(sessionId, entry);
    return entry;
  }, [drafts, sessionId]);
  useEffect(() => {
    onTerminalReveal(sessionId, terminalRevision);
  }, [sessionId, terminalRevision, onTerminalReveal]);

  return (
    <div className="studio-conversation">
      <div className="studio-conversation-body">
        {enabled && mode === "Assistant" ? (
          <OpenCodeChat
            key={`${authorityRevision}:${sessionId}`}
            harnessSessionId={sessionId}
            bootToken={bootToken}
            draft={draft}
            onSignIn={onSignIn}
            onOpenSettings={onOpenSettings}
            onOpenTerminal={() => onModeChange("Terminal")}
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
