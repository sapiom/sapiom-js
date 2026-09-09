import { useEffect, useState, type ReactNode } from "react";
import { OpenCodeChat } from "./OpenCodeChat";

/** The server owns eligibility; this is only its short-lived UI projection. */
export function AssistantPane({
  sessionId,
  bootToken,
  authRevision,
  children,
}: {
  sessionId: string;
  bootToken: string;
  authRevision: number;
  children: ReactNode;
}) {
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"Terminal" | "Assistant">("Terminal");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setEnabled(false);
    setMode("Terminal");
    const refresh = async () => {
      let allowed = false;
      try {
        const response = await fetch("/api/assistant/access", {
          headers: { "X-Harness-Token": bootToken },
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        allowed = response.ok && (await response.json()).enabled === true;
      } catch {
        /* Missing identity or host access stays off. */
      }
      if (abort.signal.aborted) return;
      setEnabled(allowed);
      if (!allowed) setMode("Terminal");
      timer = setTimeout(() => {
        void refresh();
      }, 15000);
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
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
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
