import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { BusMessage, MacroDef, WorkflowInfo } from "@shared/types";

import { isMockMode } from "../lib/api";
import { findVisualizeMacro, macroDisabledReason } from "../lib/macro-gating";
import { Icon } from "./Icon";
import { WorkflowActionsHeader } from "./WorkflowActionsHeader";

interface CanvasPaneProps {
  sessionId: string | null;
  lastMessage: BusMessage | null;
  boundWorkflow: WorkflowInfo | null;
  activeSessionId: string | null;
  macros: MacroDef[];
  onRunMacro: (macro: MacroDef) => void;
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

  // Manual affordance for the toolbar — no auto-refresh signal in mock mode,
  // and even for real sessions it's a cheap way to re-check content without
  // waiting on a canvas.reload event.
  const handleRefresh = (): void => {
    setReloadKey((key) => key + 1);
    if (!sessionId || isMockMode()) return;
    fetch(`/canvas/${sessionId}/`, { method: "HEAD" })
      .then((res) => setHasGeneratedContent(res.ok))
      .catch(() => {});
  };

  const visualizeMacro = findVisualizeMacro(macros);
  const visualizeDisabledReason = visualizeMacro
    ? macroDisabledReason(visualizeMacro, boundWorkflow, activeSessionId)
    : null;

  return (
    <aside className="canvas-pane">
      {boundWorkflow && <WorkflowActionsHeader workflow={boundWorkflow} onRefresh={handleRefresh} />}

      {!sessionId ? (
        <div className="canvas-empty">Start a session to see its canvas here.</div>
      ) : !hasGeneratedContent ? (
        <div className="canvas-empty">
          <p>Nothing generated yet.</p>
          {visualizeMacro && (
            <button
              className="btn-primary canvas-visualize-cta"
              data-testid="canvas-visualize-cta"
              data-tooltip={visualizeDisabledReason ?? visualizeMacro.label}
              disabled={Boolean(visualizeDisabledReason)}
              onClick={() => onRunMacro(visualizeMacro)}
            >
              <Icon name="Sparkles" size={14} /> Visualize
            </button>
          )}
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
