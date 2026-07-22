import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  BackgroundTask,
  BusMessage,
  MacroDef,
  RunCall,
  RunSpend,
  RunView,
  WorkflowInfo,
} from "@shared/types";

import { createApi, isMockMode } from "../lib/api";
import { formatUsd } from "../lib/format-usd";
import { findVisualizeMacro, macroDisabledReason } from "../lib/macro-gating";
import { getTheme, subscribeTheme } from "../lib/theme";
import { track } from "../lib/track";
import { Icon } from "./Icon";
import { StepDetailPanel } from "./StepDetailPanel";
import { WorkflowActionsHeader } from "./WorkflowActionsHeader";

// Module-level singleton — same pattern as use-run-polling.ts.
const api = createApi();

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
  /** Live spend/cost data for the active session's current execution, if any. */
  runSpend?: RunSpend;
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
  runSpend,
  target,
}: CanvasPaneProps): JSX.Element {
  const [hasGeneratedContent, setHasGeneratedContent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [theme, setTheme] = useState(getTheme());
  // The name of the step node the user last clicked in the canvas iframe.
  // Null when no node is selected or the panel has been closed.
  const [selectedStepName, setSelectedStepName] = useState<string | null>(null);
  // Per-call cost drill-down for the current execution, fetched lazily the
  // first time a step is drilled into. `runCallsExec` tags which execution the
  // cached calls belong to, so a new run refetches instead of showing stale.
  const [runCalls, setRunCalls] = useState<RunCall[]>([]);
  const [runCallsExec, setRunCallsExec] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Keep the latest runView in a ref so the iframe onLoad handler can read it
  // without closing over a stale value.
  const runViewRef = useRef<RunView | undefined>(runView);
  // Same for target, so a posted message never carries a stale target label.
  const targetRef = useRef<"prod" | "local">(target ?? "prod");
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
  targetRef.current = target ?? "prod";

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
          id: s.id,
          status: s.status,
          latencyMs: s.latencyMs,
        })),
        status: rv.status,
        target: targetRef.current,
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

  // Listen for node-click messages from the sandboxed canvas iframe. When a
  // `sapiom:node-click` message arrives, record the clicked step name so the
  // step-detail panel can be shown. The type guard is the only security check
  // needed — the iframe is opaque-origin, so no other page can post to us.
  useEffect(() => {
    function handleMessage(e: MessageEvent): void {
      const d = e.data as { type?: string; stepName?: string } | null;
      if (!d || d.type !== "sapiom:node-click") return;
      if (typeof d.stepName === "string") {
        setSelectedStepName(d.stepName);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Clear the selected step when the session or bound workflow changes — a
  // selection from a previous context must not bleed into the new one.
  useEffect(() => {
    setSelectedStepName(null);
  }, [sessionId, boundWorkflow]);

  // Lazily fetch the per-call cost drill-down the first time a step is drilled
  // into for a given execution (best-effort — a failure just leaves the
  // breakdown empty). Re-fetches when the execution id changes so a new run
  // never shows a prior run's calls.
  const executionId = runView?.executionId;
  useEffect(() => {
    if (!selectedStepName || !executionId) return;
    if (runCallsExec === executionId) return;
    let cancelled = false;
    const ac = new AbortController();
    api
      .getRunTransactions(executionId, ac.signal)
      .then((calls) => {
        if (!cancelled) {
          setRunCalls(calls);
          setRunCallsExec(executionId);
        }
      })
      .catch(() => {
        // Suppress retries for this run — mark it fetched so a failing
        // transactions endpoint can't refire on every step re-selection
        // (unbounded requests). The breakdown just stays empty (best-effort).
        if (!cancelled) setRunCallsExec(executionId);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [selectedStepName, executionId, runCallsExec]);

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

  // Derive the selected StepView from the current runView. Only show the panel
  // when both a step is selected and a session is active — the inject callback
  // needs a valid sessionId to send to.
  const selectedStep =
    selectedStepName != null
      ? (runView?.steps.find((s) => s.name === selectedStepName) ?? null)
      : null;

  // Per-call breakdown for the selected step — only the calls attributed to it
  // (matched on the step name the transactions endpoint reports), and only when
  // the cached calls belong to the run currently on screen.
  const selectedStepCalls =
    selectedStep && runCallsExec === executionId
      ? runCalls.filter((c) => c.stepName === selectedStep.name)
      : [];

  return (
    <aside className="canvas-pane">
      {boundWorkflow && (
        <WorkflowActionsHeader
          workflow={boundWorkflow}
          onReVisualize={handleReVisualize}
          reVisualizeDisabledReason={visualizeDisabledReason}
        />
      )}

      {runSpend && (
        <div className="run-cost-total" data-testid="run-cost-total">
          <span className="run-cost-total-label">Run cost:</span>
          <span className="run-cost-total-value">
            {formatUsd(runSpend.totalUsd)}
          </span>
          {runSpend.settleState !== "final" && (
            <span className="run-cost-total-settling">· settling</span>
          )}
        </div>
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
          {selectedStep && sessionId && (
            <StepDetailPanel
              step={selectedStep}
              spend={runSpend?.byStep.find(
                (s) => s.name === selectedStep.name,
              )}
              calls={selectedStepCalls}
              onClose={() => setSelectedStepName(null)}
              onInject={(text, submit) =>
                api.injectInput(sessionId, { text, submit })
              }
            />
          )}
        </div>
      )}
    </aside>
  );
}
