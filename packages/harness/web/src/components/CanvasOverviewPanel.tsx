import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { RunView, WorkflowInfo } from "@shared/types";

import type { CanvasGraph, CanvasGraphNode } from "../lib/canvas-graph";
import { nodeKindLabel } from "../lib/canvas-graph";
import { loadUiPrefs, saveUiPrefs } from "../lib/ui-prefs";
import { CanvasStepInspector } from "./CanvasStepDetail";
import { Icon } from "./Icon";

/** What a rendered document posts as its overview chrome (or the mock copy). */
export interface CanvasOverviewContent {
  description: string;
  stats: string;
  notes: string[];
}

/** Arrow keys move the handle by this many px (the drag's keyboard fallback). */
const KEY_RESIZE_STEP = 24;

interface CanvasOverviewPanelProps {
  /** Workflow-level overview copy; null when the document posted none. */
  overview: CanvasOverviewContent | null;
  /** The board-picked step, when one is selected — flips the panel from the
   *  general overview to that step's live inspector. */
  selectedNode: CanvasGraphNode | null;
  graph: CanvasGraph | null;
  /** The session's shown run — the inspector's status/duration/cost source. */
  run: RunView | null;
  workflows: WorkflowInfo[];
  onOpenWorkflow: (path: string) => void;
  /** Retargets the selection (a transition row picks a neighbor step). */
  onSelectStep: (id: string) => void;
  /** The full-pane drill: opens the selected step in the Steps tab. */
  onOpenSteps: () => void;
  /** Clears the selection — back to the overview. */
  onDeselect: () => void;
  /** Collapses the overview to its ⓘ reopen affordance (overview mode only). */
  onCollapse: () => void;
  /** Inject a prompt into the active terminal session (forwarded to the step
   *  inspector's debug macros). Absent when no session is live. */
  onInjectPrompt?: (text: string) => void;
}

/**
 * The Canvas tab's bottom panel: the workflow overview when nothing is
 * selected, the picked step's live inspector when a board click selects one.
 *
 * Height contract: the panel hugs its content (measured, so the change
 * animates on the height token) up to half the canvas pane; taller content
 * scrolls inside. Dragging the top edge sets a manual height override,
 * persisted in ui-prefs; double-clicking the handle (or Home on it) resets
 * to auto-hug. The handle is a keyboard-reachable horizontal separator —
 * arrow keys resize in steps.
 */
export function CanvasOverviewPanel({
  overview,
  selectedNode,
  graph,
  run,
  workflows,
  onOpenWorkflow,
  onSelectStep,
  onOpenSteps,
  onDeselect,
  onCollapse,
  onInjectPrompt,
}: CanvasOverviewPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // The user's drag override (px). Null = auto-hug. A ref, not state: it
  // only matters through measure(), and drags mutate it every frame.
  const manualRef = useRef<number | null>(loadUiPrefs().canvasInspectorHeight ?? null);
  const [height, setHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  /** Half the canvas pane — the hard cap for hug and drag alike. */
  const capHeight = (): number => {
    const pane = panelRef.current?.parentElement;
    return pane ? Math.round(pane.getBoundingClientRect().height * 0.5) : Number.MAX_SAFE_INTEGER;
  };
  /** The header row is the floor: the panel can never hide its own chrome. */
  const minHeight = (): number => (headRef.current?.offsetHeight ?? 40) + 1;

  // Content-hugging: the applied height is the measured natural height
  // (head + content + the body's padding + top border) clamped to
  // [header, half-pane], or the manual override clamped the same way.
  // Measured off the content WRAPPER, not the scroller's scrollHeight —
  // scrollHeight never reads below the current viewport, which would pin
  // the panel tall after its content shrank. Setting an explicit px
  // (instead of letting flex auto-size) is what makes the change animate.
  const measure = useCallback((): void => {
    const head = headRef.current;
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!head || !body || !content) return;
    const cap = capHeight();
    const manual = manualRef.current;
    const bodyStyle = window.getComputedStyle(body);
    const padding = (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0);
    const natural = head.offsetHeight + content.offsetHeight + padding + 1;
    const target = manual != null ? Math.min(Math.max(manual, minHeight()), cap) : Math.min(natural, cap);
    setHeight(target);
  }, []);

  // Re-measure whenever the rendered content or the pane's size changes
  // (selection swap, run data landing, pane drag-resize, viewport).
  useLayoutEffect(measure);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    const pane = panelRef.current?.parentElement;
    if (pane) observer.observe(pane);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const applyManual = (px: number): void => {
    manualRef.current = Math.round(Math.min(Math.max(px, minHeight()), capHeight()));
    measure();
  };
  const persistManual = (): void => {
    saveUiPrefs({ canvasInspectorHeight: manualRef.current });
  };
  const resetHeight = (): void => {
    manualRef.current = null;
    saveUiPrefs({ canvasInspectorHeight: null });
    measure();
  };

  // Same pointer discipline as the app's pane-resize handles: capture the
  // pointer, track dy (up grows the panel), release cleans up and persists.
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const panel = panelRef.current;
    if (!panel) return;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (and some headless envs) have no active pointer, so
      // capture may throw — the window listeners below track the drag anyway.
    }
    setResizing(true);
    const startY = e.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const onMove = (ev: PointerEvent): void => {
      applyManual(startHeight + (startY - ev.clientY));
    };
    const onUp = (): void => {
      setResizing(false);
      persistManual();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // Track on window, not the handle: once the pointer leaves the 6px handle
    // the moves must still land, whether or not pointer capture took hold.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handleResizeKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = panelRef.current?.getBoundingClientRect().height ?? 0;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      applyManual(current + KEY_RESIZE_STEP);
      persistManual();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      applyManual(current - KEY_RESIZE_STEP);
      persistManual();
    } else if (e.key === "Home") {
      e.preventDefault();
      resetHeight();
    }
  };

  return (
    <div
      ref={panelRef}
      className={"canvas-overview" + (resizing ? " is-resizing" : "") + (selectedNode ? " is-inspecting" : "")}
      data-testid="canvas-overview"
      style={height != null ? { height } : undefined}
    >
      {/* 6px top-edge hit area, row-resize cursor; keyboard fallback via the
          separator role (arrows resize, Home resets, like double-click). */}
      <div
        className="canvas-overview-resize"
        data-testid="canvas-overview-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the overview panel"
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={resetHeight}
        onKeyDown={handleResizeKey}
      />
      <div ref={headRef} className="canvas-overview-head">
        {selectedNode ? (
          <>
            <span className={"canvas-step-dot dot--" + selectedNode.kind} aria-hidden="true" />
            <span className="canvas-overview-title" data-testid="canvas-inspector-title">
              {selectedNode.label}
            </span>
            <span className={"canvas-detail-kind node--" + selectedNode.kind}>
              {nodeKindLabel(selectedNode.kind)}
            </span>
            <button
              className="status-tag status-tag-action canvas-inspector-open-steps"
              data-testid="canvas-inspector-open-steps"
              data-tooltip="Full details in the Steps tab"
              onClick={onOpenSteps}
            >
              Open in Steps <Icon name="ArrowRight" size={12} />
            </button>
            <button
              className="theme-toggle canvas-overview-close"
              data-testid="canvas-inspector-close"
              aria-label="Back to the workflow overview"
              data-tooltip="Back to the workflow overview (Esc)"
              onClick={onDeselect}
            >
              <Icon name="X" size={13} />
            </button>
          </>
        ) : (
          <>
            <Icon name="Radio" size={13} />
            Overview
            <span className="canvas-overview-stats">
              {(overview?.stats ?? "").split("·").map((pair) => {
                const part = pair.trim();
                if (!part) return null;
                const gap = part.indexOf(" ");
                const value = gap === -1 ? part : part.slice(0, gap);
                const label = gap === -1 ? "" : part.slice(gap + 1);
                return (
                  <span key={part} className="canvas-overview-stat">
                    <strong>{value}</strong> {label}
                  </span>
                );
              })}
            </span>
            <button
              className="theme-toggle canvas-overview-close"
              data-testid="canvas-overview-toggle"
              aria-label="Collapse workflow overview"
              data-tooltip="Collapse workflow overview"
              onClick={onCollapse}
            >
              <Icon name="X" size={13} />
            </button>
          </>
        )}
      </div>
      <div ref={bodyRef} className="canvas-overview-body">
        <div ref={contentRef} className="canvas-overview-content">
          {selectedNode && graph ? (
            <CanvasStepInspector
              graph={graph}
              node={selectedNode}
              run={run}
              onSelectStep={onSelectStep}
              workflows={workflows}
              onOpenWorkflow={onOpenWorkflow}
              onInjectPrompt={onInjectPrompt}
            />
          ) : (
            overview && (
              <>
                <p className="canvas-overview-desc">{overview.description}</p>
                {overview.notes.length > 0 && (
                  <ul className="canvas-overview-notes">
                    {overview.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
                <div className="canvas-legend-row" aria-hidden="true">
                  <span>
                    <span className="dot dot--entry" />
                    entry / active step
                  </span>
                  <span>
                    <span className="dot dot--step" />
                    step
                  </span>
                  <span>
                    <span className="dot dot--terminal" />
                    terminal
                  </span>
                </div>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
