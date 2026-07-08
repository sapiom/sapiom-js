import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { BusMessage, MacroDef, WorkflowInfo } from "@shared/types";

import { isMockMode } from "../lib/api";
import { findVisualizeMacro, macroDisabledReason } from "../lib/macro-gating";
import { getTheme, subscribeTheme } from "../lib/theme";
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
  const [theme, setTheme] = useState(getTheme());

  // Passed through to the served canvas so a kit-based template can match the
  // app's current theme instead of always rendering dark. Legacy canvases
  // that don't read the param are unaffected.
  useEffect(() => subscribeTheme(setTheme), []);

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

  const visualizeMacro = findVisualizeMacro(macros);
  const visualizeDisabledReason = visualizeMacro
    ? macroDisabledReason(visualizeMacro, boundWorkflow, activeSessionId)
    : null;

  // The header's action IS Visualize now — one click re-fires the same macro
  // that generated what's already on screen; the pane itself swaps in the
  // new render once the agent's canvas.reload event arrives above.
  const handleReVisualize = (): void => {
    if (!visualizeMacro) return;
    onRunMacro(visualizeMacro);
  };

  return (
    <aside className="canvas-pane">
      {boundWorkflow && (
        <WorkflowActionsHeader
          workflow={boundWorkflow}
          onReVisualize={handleReVisualize}
          reVisualizeDisabledReason={visualizeDisabledReason}
        />
      )}

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
        <iframe
          key={reloadKey}
          className="canvas-iframe"
          src={`/canvas/${sessionId}/?theme=${theme}`}
          sandbox="allow-scripts"
        />
      )}
    </aside>
  );
}
