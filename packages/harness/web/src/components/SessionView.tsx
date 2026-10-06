import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { HarnessSession, SessionSummary } from "@shared/types";

import { AssistantPane } from "./AssistantPane";
import { DeadSessionPane } from "./DeadSessionPane";
import { Icon } from "./Icon";
import type { ChatDraftStore } from "./OpenCodeChat";

export type ConversationMode = "Terminal" | "Assistant";
import { Terminal } from "./Terminal";
import { SETUP_CARD } from "../lib/creation-entry";
import { errorMessage } from "../lib/api";
import type { HarnessStateHook } from "../lib/use-harness-state";

/**
 * The Assistant's per-session drafts and sign-in, held by the shell rather
 * than by `SessionView`, so a draft survives the centre switching to a map and
 * back.
 */
export function useAssistantDrafts(harness: HarnessStateHook) {
  const snapshot = harness.assistant.snapshot;
  const enabled = snapshot?.enabled === true;
  const authorityRevision = snapshot?.authorityRevision ?? null;
  // Terminal or Assistant, per session. The header's switch sets it; losing
  // access or another account signing in puts every session back on Terminal.
  const [modes, setModes] = useState<
    Readonly<Record<string, ConversationMode>>
  >({});
  useEffect(() => setModes({}), [enabled, authorityRevision]);
  const modeFor = useCallback(
    (sessionId: string): ConversationMode =>
      enabled ? (modes[sessionId] ?? "Terminal") : "Terminal",
    [enabled, modes],
  );
  const setMode = useCallback(
    (sessionId: string, mode: ConversationMode) =>
      setModes((current) =>
        current[sessionId] === mode ? current : { ...current, [sessionId]: mode },
      ),
    [],
  );
  // Draft text belongs to a principal + Studio session, not to whichever
  // centre-pane branch happens to be mounted. An auth barrier replaces this
  // whole store; an app reload intentionally drops it rather than persisting
  // sensitive, unsent text.
  const drafts = useMemo<ChatDraftStore>(
    () => new Map(),
    [authorityRevision, harness.authRevision, harness.bootToken],
  );
  // Successful session deletion removes its keyed draft. Exited sessions stay
  // in state (and keep their draft) until the user actually closes them.
  useEffect(() => {
    if (!harness.state) return;
    const sessionIds = new Set(harness.state.sessions.map(({ id }) => id));
    for (const id of drafts.keys()) {
      if (!sessionIds.has(id)) drafts.delete(id);
    }
  }, [drafts, harness.state]);
  const signIn = useCallback(() => {
    void harness.startAuth().catch((error) => {
      harness.showToast(errorMessage(error, "Could not start sign-in."));
    });
  }, [harness.showToast, harness.startAuth]);
  return { drafts, enabled, authorityRevision, signIn, modeFor, setMode };
}

/**
 * THE SESSION VIEW: the selected session's workbench (Terminal, Assistant by
 * toggle), or its dead pane once it exited. Nothing sits beside it: agent
 * detail belongs to the project view (flow-map-chat-overlay.md 4.4.1).
 */
export function SessionView({
  harness,
  session,
  exited,
  setup,
  deadResumeMode,
  assistant,
  onOpenSettings,
  onHide,
}: {
  harness: HarnessStateHook;
  session: HarnessSession;
  /** The session exited: its dead pane rather than its terminal. */
  exited: boolean;
  /** The planning instructions its first prompt was set up with, if any. */
  setup: string | undefined;
  deadResumeMode: SessionSummary["resumeMode"] | undefined;
  assistant: ReturnType<typeof useAssistantDrafts>;
  onOpenSettings: () => void;
  onHide: (id: string) => void;
}): JSX.Element {
  const terminalRevision =
    harness.terminalRevealBySession.get(session.id) ?? 0;
  // A session that just ended shows its ended pane first, not its chat.
  const { setMode } = assistant;
  useEffect(() => {
    if (exited) setMode(session.id, "Terminal");
  }, [exited, session.id, setMode]);
  if (exited) {
    return (
      <AssistantPane
        sessionId={session.id}
        bootToken={harness.bootToken}
        enabled={assistant.enabled}
        mode={assistant.modeFor(session.id)}
        onModeChange={(mode) => assistant.setMode(session.id, mode)}
        drafts={assistant.drafts}
        authorityRevision={assistant.authorityRevision}
        onSignIn={assistant.signIn}
        onOpenSettings={onOpenSettings}
        terminalRevision={terminalRevision}
      >
        <DeadSessionPane
          session={session}
          resumeMode={deadResumeMode}
          loadRecord={harness.sessionRecord}
          onResume={() => void harness.resumeSession(session.id)}
          onContinue={() =>
            void harness.rehydrateSession({
              cwd: session.cwd,
              harness: session.harness,
              from: session.id,
            })
          }
          /* Close on an ended session is the rail's × on its row:
             hidden from the rail, kept in History (Q4), and the
             centre moves to its project's map. */
          onClose={() => onHide(session.id)}
        />
      </AssistantPane>
    );
  }
  return (
    <div className="agent-view" data-testid="agent-view">
      <div className="agent-view-panel" id="agent-panel-terminal">
        {/* THE SETUP DISCLOSURE (§4.4 step 3): the planning
            instructions rode the first prompt as session setup.
            The pane shows the idea as the user's turn (the CLI
            prints its first argument) and the instructions here,
            quietly, so the user can read what the agent was told
            without it reading as their words. */}
        {setup !== undefined && (
          <details className="session-setup" data-testid="session-setup">
            <summary className="session-setup-summary">
              <Icon name="ListChecks" size={13} />
              <span className="session-setup-title">{SETUP_CARD.title}</span>
              <span className="session-setup-hint">{SETUP_CARD.summary}</span>
            </summary>
            <pre className="session-setup-body" data-testid="session-setup-body">
              {setup}
            </pre>
          </details>
        )}
        <AssistantPane
          sessionId={session.id}
          bootToken={harness.bootToken}
          enabled={assistant.enabled}
          mode={assistant.modeFor(session.id)}
          onModeChange={(mode) => assistant.setMode(session.id, mode)}
          drafts={assistant.drafts}
          authorityRevision={assistant.authorityRevision}
          onSignIn={assistant.signIn}
          onOpenSettings={onOpenSettings}
          terminalRevision={terminalRevision}
        >
          <Terminal
            sessionId={session.id}
            token={harness.bootToken}
            cwd={session.cwd}
          />
        </AssistantPane>
      </div>
    </div>
  );
}
