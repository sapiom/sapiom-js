import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  OpenCodeChat,
  type ChatDraft,
  type ChatDraftStore,
} from "./OpenCodeChat";

/** The server owns eligibility; this is only its short-lived UI projection. */
export function AssistantPane({
  sessionId,
  bootToken,
  authRevision,
  terminalRevision,
  drafts,
  onSignIn,
  onOpenSettings,
  children,
}: {
  sessionId: string;
  bootToken: string;
  authRevision: number;
  terminalRevision: number;
  drafts: ChatDraftStore;
  onSignIn: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
}) {
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"Terminal" | "Assistant">("Terminal");
  const draft = useMemo(() => {
    const entry = drafts.get(sessionId) ?? { text: "" };
    drafts.set(sessionId, entry);
    return entry;
  }, [drafts, sessionId]);
  const revealed = useRef(new Map<string, number>());
  useEffect(() => {
    if (terminalRevision > (revealed.current.get(sessionId) ?? 0)) {
      revealed.current.set(sessionId, terminalRevision);
      setMode("Terminal");
    }
  }, [sessionId, terminalRevision]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let expiry: ReturnType<typeof setTimeout>;
    const disable = () => {
      clearTimeout(expiry);
      setEnabled(false);
      setMode("Terminal");
    };
    setEnabled(false);
    setMode("Terminal");
    const refresh = async () => {
      try {
        const response = await fetch("/api/assistant/access", {
          headers: { "X-Harness-Token": bootToken },
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        if (abort.signal.aborted) return;
        if (response.status === 401 || response.status === 403) disable();
        if (!response.ok) throw new Error("Access check unavailable");
        const { enabled: allowed } = await response.json();
        if (abort.signal.aborted) return;
        if (typeof allowed !== "boolean")
          throw new Error("Invalid access check");
        clearTimeout(expiry);
        setEnabled(allowed);
        if (allowed) expiry = setTimeout(disable, 60000);
        else setMode("Terminal");
      } catch {
        // A transient poll failure must not discard an open draft. This UI
        // projection expires within 60s; the host enforces its own grant.
      }
      if (abort.signal.aborted) return;
      timer = setTimeout(() => {
        void refresh();
      }, 15000);
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
      clearTimeout(expiry);
    };
  }, [bootToken, authRevision]);

  return (
    <div className="studio-conversation">
      {enabled && (
        <div
          className="studio-conversation-switch"
          role="group"
          aria-label="Conversation view"
        >
          {(["Terminal", "Assistant"] as const).map((view) => (
            <button
              key={view}
              type="button"
              className="btn-ghost"
              aria-pressed={mode === view}
              onClick={() => setMode(view)}
            >
              {view}
            </button>
          ))}
        </div>
      )}
      <div className="studio-conversation-body">
        {enabled && mode === "Assistant" ? (
          <OpenCodeChat
            key={sessionId}
            harnessSessionId={sessionId}
            bootToken={bootToken}
            draft={draft}
            onSignIn={onSignIn}
            onOpenSettings={onOpenSettings}
            onOpenTerminal={() => setMode("Terminal")}
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
