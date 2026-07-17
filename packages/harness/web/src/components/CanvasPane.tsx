import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  BackgroundTask,
  BusMessage,
  MacroDef,
  RunView,
  WorkflowInfo,
} from "@shared/types";

import { isMockMode } from "../lib/api";
import { findVisualizeMacro, macroDisabledReason } from "../lib/macro-gating";
import { getTheme, subscribeTheme } from "../lib/theme";
import { track } from "../lib/track";
import { Icon } from "./Icon";
import { WorkflowActionsHeader } from "./WorkflowActionsHeader";

/** How many of a running task's trailing status lines the activity view shows. */
const ACTIVITY_LINES_SHOWN = 8;

interface CanvasPaneProps {
  sessionId: string | null;
  lastMessage: BusMessage | null;
  boundWorkflow: WorkflowInfo | null;
  activeSessionId: string | null;
  macros: MacroDef[];
  /** All background tasks (any session) — filtered to `sessionId` here. */
  tasks: BackgroundTask[];
  onRunMacro: (macro: MacroDef) => void;
  /** Live run state for the active session's current execution, if any. */
  runView?: RunView;
  /** Execution target — governs the badge label ("running" vs "testing"). */
  target?: "prod" | "local";
}

export function CanvasPane({
  sessionId,
  lastMessage,
  boundWorkflow,
  activeSessionId,
  macros,
  tasks,
  onRunMacro,
  runView,
  target,
}: CanvasPaneProps): JSX.Element {
  const [hasGeneratedContent, setHasGeneratedContent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [theme, setTheme] = useState(getTheme());
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Keep the latest runView in a ref so the iframe onLoad handler can read it
  // without closing over a stale value.
  const runViewRef = useRef<RunView | undefined>(runView);
  // True while the initial HEAD probe for this session is still in flight —
  // the pane shows a loading state instead of flashing "Nothing generated
  // yet" at content that's about to appear.
  const [probing, setProbing] = useState(false);
  // True while the iframe is (re)loading its document — a skeleton overlays
  // it so a load/render in progress never reads as a blank pane.
  const [frameLoading, setFrameLoading] = useState(true);
  // Failed-task panels the user has explicitly dismissed (client-side only —
  // the task record itself stays in the server's list).
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(
    new Set(),
  );

  // Keep the ref current on every render so onLoad (which captures it by ref)
  // always reads the freshest value.
  runViewRef.current = runView;

  // Post the current run state into the iframe. Called both from the iframe's
  // onLoad (so freshly-loaded frames get the current state) and from a runView
  // effect (so state updates reach an already-loaded frame). Posts to "*"
  // because the sandboxed iframe is opaque-origin — no other origin can be
  // specified. The iframe listener validates `data.type` as its guard.
  function postRunState(): void {
    const rv = runViewRef.current;
    if (!rv) return;
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: "sapiom:run-state",
        steps: rv.steps.map((s) => ({
          name: s.name,
          status: s.status,
          latencyMs: s.latencyMs,
        })),
        status: rv.status,
        target: target ?? "prod",
      },
      "*",
    );
  }

  // Re-post whenever runView changes — the iframe may already be loaded.
  useEffect(() => {
    postRunState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runView]);

  // Passed through to the served canvas so a kit-based template can match the
  // app's current theme instead of always rendering dark. Legacy canvases
  // that don't read the param are unaffected.
  useEffect(() => subscribeTheme(setTheme), []);

  // Probe once per session for pre-existing content — the agent may have written
  // it in an earlier turn, before this pane was around to catch a reload event.
  useEffect(() => {
    setHasGeneratedContent(false);
    setFrameLoading(true);
    if (!sessionId || isMockMode()) return;
    let cancelled = false;
    setProbing(true);
    fetch(`/canvas/${sessionId}/`, { method: "HEAD" })
      .then((res) => !cancelled && setHasGeneratedContent(res.ok))
      .catch(() => {})
      .finally(() => !cancelled && setProbing(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!lastMessage || !sessionId) return;
    if (
      lastMessage.type === "canvas.reload" &&
      lastMessage.harnessSessionId === sessionId
    ) {
      setHasGeneratedContent(true);
      setFrameLoading(true);
      setReloadKey((key) => key + 1);
    }
  }, [lastMessage, sessionId]);

  // The server resolves the canvas root by the session's CURRENT binding, so
  // a bind/unbind changes what the same URL serves — refetch immediately
  // instead of waiting for the render write's canvas.reload to arrive.
  const boundWorkflowPath = boundWorkflow?.path ?? null;
  useEffect(() => {
    setFrameLoading(true);
    setReloadKey((key) => key + 1);
  }, [boundWorkflowPath]);

  const visualizeMacro = findVisualizeMacro(macros);
  const visualizeDisabledReason = visualizeMacro
    ? macroDisabledReason(visualizeMacro, boundWorkflow, activeSessionId)
    : null;

  // Background-task state for THIS session's pane, scoped to the CURRENT
  // binding: a task that carries a workflowPath only surfaces while the pane
  // is showing that workflow — switching the binding mid-run must not bleed
  // another workflow's activity (or failure) into this one's pane. Tasks
  // without a workflowPath keep the plain per-session scoping. A running
  // task shows the live activity view; otherwise the most recently finished
  // task, if it failed and hasn't been dismissed, shows the failure view
  // with a retry.
  const sessionTasks = tasks.filter(
    (task) =>
      task.harnessSessionId === sessionId &&
      (task.workflowPath == null || task.workflowPath === boundWorkflowPath),
  );
  const runningTask =
    sessionTasks.find((task) => task.status === "running") ?? null;
  const latestFinished = sessionTasks
    .filter((task) => task.status !== "running")
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  const failedTask =
    !runningTask &&
    latestFinished?.status === "failed" &&
    !dismissedTaskIds.has(latestFinished.id)
      ? latestFinished
      : null;
  const retryMacro = failedTask
    ? (macros.find((macro) => macro.id === failedTask.macroId) ?? null)
    : null;

  // The header's action IS Visualize now — one click re-fires the same macro
  // that generated what's already on screen; the pane itself swaps in the
  // new render once the agent's canvas.reload event arrives above.
  const handleReVisualize = (): void => {
    if (!visualizeMacro) return;
    onRunMacro(visualizeMacro);
    track("visualize.triggered");
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
        <div className="canvas-empty">
          Start a session to see its canvas here.
        </div>
      ) : failedTask ? (
        <div className="canvas-task-failed" data-testid="canvas-task-failed">
          <p className="canvas-task-title">
            <Icon name="TriangleAlert" size={14} /> {failedTask.label} failed.
          </p>
          {failedTask.errorTail && (
            <pre className="canvas-task-error">{failedTask.errorTail}</pre>
          )}
          <div className="canvas-task-actions">
            {retryMacro && (
              <button
                className="btn-primary"
                data-testid="canvas-task-retry"
                onClick={() => onRunMacro(retryMacro)}
              >
                Retry
              </button>
            )}
            <button
              className="btn-ghost"
              data-testid="canvas-task-dismiss"
              onClick={() =>
                setDismissedTaskIds((prev) => {
                  const next = new Set(prev);
                  next.add(failedTask.id);
                  return next;
                })
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : runningTask && !hasGeneratedContent ? (
        <div
          className="canvas-task-activity"
          data-testid="canvas-task-activity"
        >
          <div className="canvas-task-title">
            <span className="canvas-task-spinner" aria-hidden="true" />
            <span>{runningTask.label} is running…</span>
          </div>
          {runningTask.statusLines.length > 0 && (
            <ul className="canvas-task-lines" data-testid="canvas-task-lines">
              {runningTask.statusLines
                .slice(-ACTIVITY_LINES_SHOWN)
                .map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
            </ul>
          )}
          <p className="canvas-empty-hint">
            Running as a background task — your session stays free. The canvas
            reloads here when it finishes.
          </p>
        </div>
      ) : probing ? (
        <div className="canvas-loading" data-testid="canvas-loading">
          <span className="canvas-task-spinner" aria-hidden="true" />
          <p className="canvas-empty-hint">Loading canvas…</p>
        </div>
      ) : !hasGeneratedContent ? (
        <div className="canvas-empty">
          <p>Nothing generated yet.</p>
          {visualizeMacro && (
            <button
              className="btn-primary canvas-visualize-cta"
              data-testid="canvas-visualize-cta"
              data-tooltip={visualizeDisabledReason ?? visualizeMacro.label}
              disabled={Boolean(visualizeDisabledReason)}
              onClick={() => {
                onRunMacro(visualizeMacro);
                track("visualize.triggered");
              }}
            >
              <Icon name="Sparkles" size={14} /> Visualize
            </button>
          )}
          <p className="canvas-empty-hint">
            Ask your agent to visualize, or write HTML directly to{" "}
            <code>.sapiom/canvas/index.html</code> — this pane hot-reloads
            whenever it changes.
          </p>
        </div>
      ) : (
        <div className="canvas-frame-wrap">
          {frameLoading && (
            <div
              className="canvas-loading canvas-loading--overlay"
              data-testid="canvas-loading"
            >
              <span className="canvas-task-spinner" aria-hidden="true" />
              <p className="canvas-empty-hint">Rendering diagram…</p>
            </div>
          )}
          {runningTask && (
            <div
              className="canvas-task-activity canvas-task-activity--overlay"
              data-testid="canvas-task-activity"
            >
              <div className="canvas-task-title">
                <span className="canvas-task-spinner" aria-hidden="true" />
                <span>{runningTask.label} is running…</span>
              </div>
              {runningTask.statusLines.length > 0 && (
                <ul
                  className="canvas-task-lines"
                  data-testid="canvas-task-lines"
                >
                  {runningTask.statusLines
                    .slice(-ACTIVITY_LINES_SHOWN)
                    .map((line, index) => (
                      <li key={`${index}-${line}`}>{line}</li>
                    ))}
                </ul>
              )}
              <p className="canvas-empty-hint">
                Running as a background task — your session stays free. The
                canvas reloads here when it finishes.
              </p>
            </div>
          )}
          <iframe
            key={`${sessionId}:${reloadKey}`}
            ref={iframeRef}
            className="canvas-iframe"
            src={`/canvas/${sessionId}/?theme=${theme}`}
            sandbox="allow-scripts"
            onLoad={() => {
              setFrameLoading(false);
              postRunState();
            }}
          />
        </div>
      )}
    </aside>
  );
}
