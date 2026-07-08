import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { BusMessage, MacroDef, WorkflowInfo } from "@shared/types";

import { isMockMode } from "../lib/api";
import { needsSubject } from "../lib/macro-gating";
import { Icon } from "./Icon";
import { WorkflowActionsHeader } from "./WorkflowActionsHeader";

interface CanvasPaneProps {
  sessionId: string | null;
  lastMessage: BusMessage | null;
  boundWorkflow: WorkflowInfo | null;
  activeSessionId: string | null;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef, subject?: string) => void;
}

export function CanvasPane({
  sessionId,
  lastMessage,
  boundWorkflow,
  activeSessionId,
  macros,
  onRunMacro,
}: CanvasPaneProps): JSX.Element {
  const [hasGeneratedContent, setHasGeneratedContent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [visualizing, setVisualizing] = useState(false);
  const [visualizeSubject, setVisualizeSubject] = useState("");

  // Probe once per session for pre-existing content — the agent may have written
  // it in an earlier turn, before this pane was around to catch a reload event.
  useEffect(() => {
    setHasGeneratedContent(false);
    if (!sessionId || isMockMode()) return;
    let cancelled = false;
    fetch(`/canvas/${sessionId}/`, { method: "HEAD" })
      .then((res) => !cancelled && setHasGeneratedContent(res.ok))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!lastMessage || !sessionId) return;
    if (lastMessage.type === "canvas.reload" && lastMessage.harnessSessionId === sessionId) {
      setHasGeneratedContent(true);
      setReloadKey((key) => key + 1);
    }
  }, [lastMessage, sessionId]);

  const visualizeMacro = macros.find(needsSubject);
  const submitVisualize = (): void => {
    if (!visualizeMacro) return;
    onRunMacro(visualizeMacro, visualizeSubject.trim() || undefined);
    setVisualizing(false);
  };

  return (
    <aside className="canvas-pane">
      {boundWorkflow && (
        <WorkflowActionsHeader
          workflow={boundWorkflow}
          activeSessionId={activeSessionId}
          macros={macros}
          onRunMacro={onRunMacro}
        />
      )}

      {!sessionId ? (
        <div className="canvas-empty">Start a session to see its canvas here.</div>
      ) : !hasGeneratedContent ? (
        <div className="canvas-empty">
          <p>Nothing generated yet.</p>
          {visualizeMacro &&
            (visualizing ? (
              <div className="canvas-visualize-inline">
                <input
                  autoFocus
                  className="modal-input"
                  data-testid="canvas-visualize-subject"
                  placeholder="What should the agent visualize?"
                  value={visualizeSubject}
                  onChange={(e) => setVisualizeSubject(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitVisualize();
                    if (e.key === "Escape") setVisualizing(false);
                  }}
                />
                <div className="modal-actions">
                  <button className="btn-ghost" onClick={() => setVisualizing(false)}>
                    Cancel
                  </button>
                  <button className="btn-primary" onClick={submitVisualize}>
                    Run
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="btn-primary canvas-visualize-cta"
                data-testid="canvas-visualize-cta"
                onClick={() => {
                  setVisualizeSubject("");
                  setVisualizing(true);
                }}
              >
                <Icon name="Sparkles" size={14} /> Visualize
              </button>
            ))}
          <p className="canvas-empty-hint">
            Ask your agent to visualize, or write HTML directly to <code>.sapiom/canvas/index.html</code> — this pane
            hot-reloads whenever it changes.
          </p>
        </div>
      ) : (
        <iframe key={reloadKey} className="canvas-iframe" src={`/canvas/${sessionId}/`} sandbox="allow-scripts" />
      )}
    </aside>
  );
}
