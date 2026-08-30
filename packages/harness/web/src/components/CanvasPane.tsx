import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { BackgroundTask, BusMessage, MacroDef, RunView, WorkflowInfo } from "@shared/types";

import { ApiError, isMockMode, type WorkflowGraphResponse } from "../lib/api";
import { MOCK_CANVAS_OVERVIEWS, hasMockCanvasDoc } from "../lib/mock-data";
import { getTheme, subscribeTheme } from "../lib/theme";
import type { CanvasSource } from "../lib/session-scope";
import { type CanvasGraph, formatGraphCounts, parseCanvasGraph } from "../lib/canvas-graph";
import type { DeployProgress, ObservedRun, RunTarget } from "../lib/use-harness-state";
import { CanvasOverviewPanel } from "./CanvasOverviewPanel";
import type { CanvasLegendItem, CanvasOverviewContent } from "./CanvasOverviewPanel";
import {
  CanvasChatPanel,
  CanvasStepsList,
  DeployStatusBanner,
} from "./CanvasStepDetail";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { WorkflowActionsHeader } from "./WorkflowActionsHeader";
import { RunWorkspace } from "./RunWorkspace";
import { SnippetPanel } from "./SnippetPanel";
import { isWorkflowRunnable, workflowDeploymentState } from "../lib/workflow-deployment";
import { track as trackProduct } from "../lib/analytics/events";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/** How many of a running task's trailing status lines the activity view shows. */
const ACTIVITY_LINES_SHOWN = 8;

/** Safety net for the loading skeleton: if the iframe never fires `onLoad` (a
 *  bad / legacy / errored document), settle the overlay after this long so it
 *  can't strand opaquely over an otherwise-usable board. */
const FRAME_LOAD_TIMEOUT_MS = 4000;

/**
 * How long a changed selection settles before the workflow-keyed board is
 * fetched.
 *
 * A cache miss on that route runs a real esbuild extraction (shared with
 * bind-triggered renders via `core/canvas-cache.ts`), so it is a render, not a
 * lookup — and arrowing down the rail would otherwise queue one per row. Short
 * enough that a deliberate click still feels immediate.
 */
const WORKFLOW_BOARD_SETTLE_MS = 220;

/**
 * The workflow-keyed board as this pane needs it: the route's four statuses
 * plus the three ways the request itself can fail, kept distinct because each
 * one means something different to the person reading the pane.
 *
 * `notRegistered` is the ONLY meaning of a 404 — an agent whose `sapiom.json`
 * is missing answers `200 empty` (absent ⇒ empty, never an error), so an empty
 * board can never be mistaken for a missing route.
 */
interface WorkflowBoard {
  /** The subject this answer is about — a late reply for the previous
   *  selection must not be drawn under the current one. */
  path: string;
  status: WorkflowGraphResponse["status"] | "notRegistered" | "rejected" | "unreachable";
  /** The finished document, for `srcdoc`; null when the request itself failed. */
  document: string | null;
  reason: string | null;
}

/**
 * The two theme scripts, WRITTEN OUT RATHER THAN BUILT.
 *
 * A served document reads `?theme=` off its own URL; a `srcdoc` frame has no
 * URL and no query string, so it would fall back to `prefers-color-scheme` and
 * paint light while the app is dark. Appending a script is enough — the parser
 * hoists a trailing script into the body and it runs before first paint of the
 * board's own content. Both attribute names are set because the server template
 * keys on `data-canvas-theme` and the bundled demo document on `data-theme`.
 *
 * The value used to be interpolated with `JSON.stringify`, which is the classic
 * near-miss: JSON escaping is not SCRIPT escaping, and a value containing
 * `</script` or `<!--` closes the element early no matter how valid the JSON
 * is. So there is nothing to escape — the theme selects one of two constant
 * strings and never becomes part of one.
 */
const FRAME_THEME_SCRIPTS = {
  light:
    '<script>(function(){var r=window.document.documentElement;r.setAttribute("data-canvas-theme","light");r.setAttribute("data-theme","light");})();</script>',
  dark: '<script>(function(){var r=window.document.documentElement;r.setAttribute("data-canvas-theme","dark");r.setAttribute("data-theme","dark");})();</script>',
} as const;

/** The app's theme, handed to a `srcdoc` frame — see {@link FRAME_THEME_SCRIPTS}. */
function withFrameTheme(document: string, theme: string): string {
  return `${document}${theme === "dark" ? FRAME_THEME_SCRIPTS.dark : FRAME_THEME_SCRIPTS.light}`;
}

interface CanvasPaneProps {
  sessionId: string | null;
  lastMessage: BusMessage | null;
  /**
   * THE subject: the rail selection, not the active session's binding
   * (SAP-2931). Everything this pane draws, labels, gates and attributes reads
   * this one value, so the board and the Steps list cannot be about different
   * agents.
   */
  subjectWorkflow: WorkflowInfo | null;
  /**
   * Which canvas entry point serves the subject's document — the session-keyed
   * board when the active session is bound to the subject, IA-01's
   * workflow-keyed route otherwise (`lib/session-scope.ts:canvasSourceFor`).
   * An agent that has never hosted a session is served by the second one; it is
   * no longer a hole in the pane.
   */
  source: CanvasSource;
  /**
   * Reads the workflow-keyed board. It is a `fetch`, never an `<iframe src>`:
   * the route sits behind the `X-Harness-Token` middleware and a bare `src`
   * carries no header, so the JSON's `document` is rendered via `srcdoc`.
   * Rejects `ApiError(404)` for an unregistered path, `ApiError(400)` for a
   * rejected one.
   */
  loadWorkflowGraph: (workflowPath: string) => Promise<WorkflowGraphResponse>;
  /** the overview/welcome panel owns the center pane — no session is
   *  displayed, so the canvas shows the fresh-install "start a session"
   *  state instead of the previous session's empty state and CTA. */
  overviewActive: boolean;
  /** the displayed session has exited — Visualize can't do anything, so the
   *  empty state swaps to a resume invitation. Only reachable while the board
   *  is session-keyed; a subject served by the workflow-keyed route has a real
   *  board whether or not any session is alive. */
  sessionExited: boolean;
  /** Canvas full-screen state + toggle — owned by App so the control sits in
   *  the right-pane tab bar; CanvasPane renders the frame + exit affordance. */
  expanded: boolean;
  onToggleExpanded: () => void;
  macros: MacroDef[];
  /** All background tasks (any session) — filtered to `sessionId` here. */
  tasks: BackgroundTask[];
  onRunMacro: (macro: MacroDef) => void;
  /** Sends a prompt to the active session's agent (used by the render-error
   *  state's one-click fix). */
  onInjectPrompt: (text: string) => void;
  /** Runs the "Describe with AI" background macro for a workflow — a headless
   *  agent authors the source `description` fields (never the interactive
   *  terminal). The button's loading state is driven by the resulting task. */
  onDescribeWorkflow: (workflow: WorkflowInfo) => void;
  /** Which projection of the rendered document is showing: the board, or
   *  the Steps tab (list + per-step detail) built from its posted graph. */
  surface: "board" | "steps";
  /** Switches the right pane to the Steps tab (the inspector's explicit
   *  "Open in Steps" drill — a board pick stays on the Canvas tab now). */
  onOpenSteps: () => void;
  /** The run this session's Steps tab shows (latest observed, or a picker
   *  choice), or null when nothing has run. Structure renders either way. */
  run: RunView | null;
  /** Where that run executed (prod / local); local runs are stubbed. */
  runTarget: RunTarget | null;
  /** Every run observed for this session, oldest first (the run picker). */
  runs: ObservedRun[];
  onSelectRun: (executionId: string) => void;
  /** Dev server the agent started in this session (port.detected), if any —
   *  the run summary offers it as an "Open preview" result when the agent
   *  isn't deployed. */
  preview: { port: number; url: string } | null;
  /** Live deploy progress for the bound workflow, or null — drives the deploy
   *  banner in the Steps surface (linking → building → ready/error). */
  deployState: DeployProgress | null;
  /** Dismiss the deploy banner (clears the workflow's deploy progress). */
  onDismissDeploy: () => void;
  /**
   * The Agents API base URL (from AppState) — the executions host the
   * integration snippets target. Undefined on servers that predate the field
   * (and in mocks), where `generateSnippet` falls back to the SDK's default.
   */
  agentsBaseUrl?: string;
  /**
   * Bring the integration snippets into view.
   *
   * They used to live behind a permanent `Code` tab, which spent standing IA on
   * a question asked once, just after a deploy. They now live on the DEPLOY
   * surface — beside the banner that reports the build that made them callable
   * — so the deploy banner's "Trigger from your code" opens the disclosure
   * here and asks the shell (this prop) to make sure the Steps surface is the
   * one on screen.
   */
  onOpenCode: () => void;
  /** Registry workflows — launched-workflow nodes navigate to theirs. */
  workflows: WorkflowInfo[];
  /** Binds and switches to another workflow (App's handleBindWorkflow) —
   *  navigating to a launched workflow is an explicit act on it, so it
   *  rebinds, same as running a macro against it. */
  onOpenWorkflow: (path: string) => void;
  /** Reports whether THIS session currently has a REAL rendered board, so the
   *  workbench can follow it: shown when a step graph exists, hidden when it
   *  doesn't.
   *
   *  "Real" means the document posted `sapiom-canvas:graph` — not merely that
   *  a file exists. A canvas write also happens for the "Preparing your agent
   *  — installing dependencies" placeholder (and the server answers an
   *  unrendered bound session with a "Rendering agent diagram…" document), and
   *  revealing the pane for those presented setup scaffolding as if it were
   *  the result. Those documents deliberately post nothing, so waiting for the
   *  graph message is what separates them.
   *
   *  Fires on the mount probe, whenever the session changes, and once a graph
   *  arrives — the last case is what opens the pane the moment an agent
   *  finishes rendering a board, even one the user had collapsed. */
  onCanvasState?: (hasContent: boolean) => void;
  /** Publishes the manifest-backed graph already visible in this pane so the
   * Run sheet can reuse its entry contract if a fresh extraction is briefly
   * unavailable. */
  onGraphChange?: (workflowPath: string, graph: CanvasGraph) => void;
}

/** A legend row posted by a rendered document, validated before it is shown. */
function isLegendItem(value: unknown): value is CanvasLegendItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { kind?: unknown; label?: unknown };
  return typeof item.kind === "string" && typeof item.label === "string";
}

export function CanvasPane({
  sessionId,
  lastMessage,
  subjectWorkflow,
  source,
  loadWorkflowGraph,
  overviewActive,
  sessionExited,
  expanded,
  onToggleExpanded,
  macros,
  tasks,
  onRunMacro,
  onInjectPrompt,
  onDescribeWorkflow,
  surface,
  onOpenSteps,
  run,
  runTarget,
  runs,
  onSelectRun,
  preview,
  deployState,
  onDismissDeploy,
  agentsBaseUrl,
  onOpenCode,
  workflows,
  onOpenWorkflow,
  onCanvasState,
  onGraphChange,
}: CanvasPaneProps): JSX.Element {
  const [hasGeneratedContent, setHasGeneratedContent] = useState(false);
  // Latest reporter, read from the content effects without listing it in their
  // deps — otherwise a new inline callback each render would re-run them and
  // re-report stale content (re-opening a pane the user just collapsed).
  const onCanvasStateRef = useRef(onCanvasState);
  onCanvasStateRef.current = onCanvasState;
  const onGraphChangeRef = useRef(onGraphChange);
  onGraphChangeRef.current = onGraphChange;
  const subjectPathRef = useRef(subjectWorkflow?.path ?? null);
  subjectPathRef.current = subjectWorkflow?.path ?? null;
  /**
   * `source` is rebuilt by the shell on every render, so nothing may depend on
   * its identity — an effect keyed to the object re-ran on every render, which
   * turned the run-state bridge into a postMessage on each one. These two
   * primitives are what the effects and callbacks below key on instead.
   */
  const workflowSourcePath = source.kind === "agent" ? source.path : null;
  const sessionSourceId = source.kind === "session" ? source.sessionId : null;
  const [reloadKey, setReloadKey] = useState(0);
  const [theme, setTheme] = useState(getTheme());
  // True while the initial HEAD probe for this session is still in flight —
  // the pane shows a loading state instead of flashing "Nothing generated
  // yet" at content that's about to appear.
  const [probing, setProbing] = useState(false);
  // True while the iframe is (re)loading its document — a skeleton overlays
  // it so a load/render in progress never reads as a blank pane. The overlay
  // outlives the flag briefly (skeletonFading) so it fades out over the
  // loaded document instead of vanishing in one frame.
  const [frameLoading, setFrameLoading] = useState(true);
  const [skeletonFading, setSkeletonFading] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A user-initiated refresh holds the skeleton at least this long even when
  // the document loads instantly, so the reload reads as a real refresh
  // instead of an imperceptible blink.
  const skeletonHoldUntilRef = useRef(0);
  const settleFrameLoaded = useCallback((): void => {
    setFrameLoading(false);
    setSkeletonFading(true);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => setSkeletonFading(false), 360);
  }, []);
  const handleFrameLoaded = (): void => {
    const holdLeft = skeletonHoldUntilRef.current - Date.now();
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (holdLeft > 0) holdTimerRef.current = setTimeout(settleFrameLoaded, holdLeft);
    else settleFrameLoaded();
  };
  useEffect(
    () => () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    },
    [],
  );
  // Safety net: a document that never fires `onLoad` (a bad / legacy / errored
  // doc, or the iframe's own onError below) must not leave the opaque skeleton
  // stranded over the board — that reads as "the canvas is stuck" even though
  // pan/zoom still work underneath. Force it to settle after a grace period.
  useEffect(() => {
    if (!frameLoading) return;
    const timer = window.setTimeout(settleFrameLoaded, FRAME_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [frameLoading, settleFrameLoaded]);
  // View controls for the rendered document: zoom scales the iframe ELEMENT
  // (with size compensation) — the sandboxed doc is never touched; expand
  // lifts the frame to a fixed overlay without remounting it, so the
  // document (and any running enrichment) survives the toggle.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panLayerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // The smallest zoom allowed — adaptive, not a fixed value: for a large graph
  // it's the exact fit-to-frame zoom (so you can zoom out until the whole thing
  // shows), for a small graph it stays at a sane 0.25. Recomputed on each fit
  // (see fitView) from the graph + pane size.
  const [minZoom, setMinZoom] = useState(0.25);
  const clampZoom = (z: number): number => Math.min(3, Math.max(minZoom, Math.round(z * 100) / 100));
  // Fit-to-view: documents that implement {type:"sapiom-canvas:size"} post
  // their graph's natural size plus reserved chrome insets (the docked zoom
  // controls' strip, side padding) — the fit excludes those insets so the
  // graph can never land under the controls. Older documents post nothing
  // and fit falls back to the identity reset.
  const [graphSize, setGraphSize] = useState<{
    width: number;
    height: number;
    insetTop: number;
    insetBottom: number;
    insetX: number;
  } | null>(null);
  // True after any deliberate view change (wheel, buttons, drag) — auto-fit
  // then stops overriding until the next document swap or an explicit Fit.
  const userAdjustedRef = useRef(false);
  // The view's rest pose (the last applied fit, or identity). The Fit
  // button re-arms whenever the live view departs from it.
  const [restView, setRestView] = useState({ zoom: 1, x: 0, y: 0 });

  const computeFit = useCallback((): { zoom: number; x: number; y: number } | null => {
    const layer = panLayerRef.current;
    if (!graphSize || !layer) return null;
    const rect = layer.getBoundingClientRect();
    // Hidden (steps tab offstage) or degenerate panes produce nonsense fits.
    if (rect.width < 80 || rect.height < 80) return null;
    const availWidth = rect.width - graphSize.insetX * 2;
    const availHeight = rect.height - graphSize.insetTop - graphSize.insetBottom;
    if (availWidth <= 0 || availHeight <= 0) return null;
    // Fit only ever shrinks (enlarging a small graph past 100% just blurs it).
    // The zoom is ESTIMATED from the graph + pane, floored only at a tiny 0.1
    // safety bound — so even a very large graph frames whole. The old hard 0.5
    // floor is exactly what left big graphs cut off.
    const fitted = Math.min(1, availWidth / graphSize.width, availHeight / graphSize.height);
    return { zoom: Math.max(0.1, Math.round(fitted * 100) / 100), x: 0, y: 0 };
  }, [graphSize]);

  const fitView = useCallback((): void => {
    // Retry across a few frames instead of snapping to 100% when the pane or
    // the document's size isn't measurable yet — on a fresh load that snap was
    // the "sometimes it opens at 100% and doesn't adapt" bug.
    let tries = 12;
    const apply = (): void => {
      const computed = computeFit();
      if (computed) {
        // Adapt the zoom-out floor to this graph: a large graph fits below 0.25,
        // so let the user reach that; a small graph keeps the ordinary 0.25 floor.
        setMinZoom(Math.min(0.25, computed.zoom));
        // An explicit fit hands the view back to auto-follow: subsequent pane
        // resizes keep it fitted until the user moves the view again.
        userAdjustedRef.current = false;
        setZoom(computed.zoom);
        setPan({ x: computed.x, y: computed.y });
        setRestView(computed);
        return;
      }
      // computeFit failed. If the document posted a size, the pane may just not
      // be measurable yet — retry a few frames. But if there's NO size to fit to
      // (a legacy / errored doc that never posts one), retrying can't help, so
      // fall back to a defined identity view instead of the old silent no-op
      // that left the Fit button looking dead.
      if (graphSize && tries-- > 0) {
        requestAnimationFrame(apply);
        return;
      }
      setMinZoom(0.25);
      userAdjustedRef.current = false;
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setRestView({ zoom: 1, x: 0, y: 0 });
    };
    apply();
  }, [computeFit, graphSize]);

  // Fit on first render (the document announces its size once laid out)…
  useEffect(() => {
    if (!graphSize || userAdjustedRef.current) return;
    fitView();
  }, [graphSize, fitView]);

  // …and on pane-size changes (drag-resize, expand, overview toggle,
  // viewport), so the default view never hides half the graph.
  useEffect(() => {
    const layer = panLayerRef.current;
    if (!layer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!userAdjustedRef.current) fitView();
    });
    observer.observe(layer);
    return () => observer.disconnect();
  }, [fitView]);

  // View contract: the iframe element never transforms (the board always
  // fills the pane); the view state is posted INTO the document, which pans
  // and scales its graph over the anchored dotted surface.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "sapiom-canvas:view", zoom, x: pan.x, y: pan.y },
      "*",
    );
    // The graph just moved under a possibly stationary cursor: re-hit-test
    // at the resting position so hover/cursor never go stale.
    const rest = lastPointer.current;
    const frame = frameRef.current;
    if (rest && frame) {
      const rect = frame.getBoundingClientRect();
      frame.contentWindow?.postMessage(
        { type: "sapiom-canvas:hover", x: rest.x - rect.left, y: rest.y - rect.top },
        "*",
      );
    }
  }, [zoom, pan]);

  // Wheel-to-zoom on the board. A native non-passive listener: React's
  // synthetic wheel handler can't preventDefault, and without it the page
  // would scroll-chain instead of zooming.
  useEffect(() => {
    const layer = panLayerRef.current;
    if (!layer) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      userAdjustedRef.current = true;
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    layer.addEventListener("wheel", onWheel, { passive: false });
    return () => layer.removeEventListener("wheel", onWheel);
  });

  // The gesture layer sits OVER the iframe, so the document never sees raw
  // pointer events and its CSS :hover can never fire. Interaction states ride
  // the same message contract picks use: the app forwards hover/press
  // coordinates, the document hit-tests its own nodes, applies the state
  // class, and answers hovers with {type:"sapiom-canvas:hit", id|null} so the
  // gesture layer can flip its cursor to pointer over clickable nodes.
  const postToFrame = (msg: Record<string, unknown>): void => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (typeof msg.clientX === "number" && typeof msg.clientY === "number") {
      const { clientX, clientY, ...rest } = msg;
      frame.contentWindow?.postMessage({ ...rest, x: clientX - rect.left, y: clientY - rect.top }, "*");
      return;
    }
    frame.contentWindow?.postMessage(msg, "*");
  };
  const [hoveredNode, setHoveredNode] = useState(false);
  // Mirror of the latest hover hit-test answer, readable inside the click
  // handler's closure: a non-drag click that lands on empty board space
  // (no node under the pointer) clears the inspector selection.
  const hoveredNodeRef = useRef(false);
  const hoverRaf = useRef(0);
  // Where the pointer currently rests (null once it leaves) — zoom and fit
  // move the graph under a stationary cursor, so the view effect re-runs the
  // hit-test from here instead of waiting for the next pointermove.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const forwardHover = (e: React.PointerEvent<HTMLDivElement>): void => {
    lastPointer.current = { x: e.clientX, y: e.clientY };
    // Mid-pan the pointer sweeps the whole board; retargeting hover would
    // flash every node it crosses.
    if (panning) return;
    const { clientX, clientY } = e;
    cancelAnimationFrame(hoverRaf.current);
    hoverRaf.current = requestAnimationFrame(() => {
      postToFrame({ type: "sapiom-canvas:hover", clientX, clientY });
    });
  };
  const clearHover = (): void => {
    cancelAnimationFrame(hoverRaf.current);
    lastPointer.current = null;
    setHoveredNode(false);
    hoveredNodeRef.current = false;
    postToFrame({ type: "sapiom-canvas:hover", x: -1, y: -1 });
  };

  const startPan = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const layer = e.currentTarget;
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      // No active pointer to capture (synthetic events); dragging still
      // works as long as the pointer stays over the layer.
    }
    setPanning(true);
    postToFrame({ type: "sapiom-canvas:press", clientX: e.clientX, clientY: e.clientY, down: true });
    let pressed = true;
    const releasePress = (): void => {
      if (!pressed) return;
      pressed = false;
      postToFrame({ type: "sapiom-canvas:press", down: false });
    };
    let lastX = e.clientX;
    let lastY = e.clientY;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: PointerEvent): void => {
      // Snapshot the delta NOW: the setPan updater runs later (batched), by
      // which time lastX/lastY have already advanced and would zero it out.
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      // Once the gesture reads as a drag it is a PAN, not a click-in-progress:
      // drop the pressed state so the node doesn't stay stuck depressed.
      if (Math.abs(ev.clientX - startX) >= 4 || Math.abs(ev.clientY - startY) >= 4) {
        releasePress();
        userAdjustedRef.current = true;
      }
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    };
    const onUp = (ev: PointerEvent): void => {
      setPanning(false);
      releasePress();
      layer.removeEventListener("pointermove", onMove);
      layer.removeEventListener("pointerup", onUp);
      layer.removeEventListener("pointercancel", onUp);
      // A press that never really moved is a CLICK: forward it to the
      // document as a pick — it hit-tests its own nodes and answers with
      // {type:"sapiom-canvas:node", id} (which populates the inspector).
      // A click on empty board space (no node under the pointer, so the
      // document will answer nothing) deselects instead.
      if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) {
        postToFrame({ type: "sapiom-canvas:pick", clientX: ev.clientX, clientY: ev.clientY });
        if (!hoveredNodeRef.current) setSelectedNodeId(null);
      }
    };
    layer.addEventListener("pointermove", onMove);
    layer.addEventListener("pointerup", onUp);
    layer.addEventListener("pointercancel", onUp);
  };

  // The board-picked step whose detail the bottom inspector shows. Separate
  // from detailStepId (the Steps tab's full-pane drill): a pick stays on the
  // Canvas tab now, populating the panel below the board in real time.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Escape unwinds one layer per press: an open inspector selection clears
  // first; only then does the expanded overlay exit (its own exit button
  // still works either way).
  useEffect(() => {
    // The run workspace portal owns Focus-mode Escape handling so each press
    // unwinds exactly one layer and the underlying Canvas selection cannot
    // react while it is inert.
    if (surface === "steps" && run && expanded) return;
    if (!expanded && selectedNodeId == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (selectedNodeId != null) setSelectedNodeId(null);
      else onToggleExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, selectedNodeId, onToggleExpanded, run, surface]);
  const [overviewOpen, setOverviewOpen] = useState(true);
  // The chat (macros + ask) is a standalone panel, CLOSED by default and
  // toggled by the 💬 control — independent of the info panel (both can be
  // open at once; the chat also opens with no step selected, as a general ask).
  const [chatOpen, setChatOpen] = useState(false);
  // Overview contract: a rendered document may post its chrome content
  // ({type:"sapiom-canvas:overview", description, stats, notes[]}) so the APP
  // renders the overview panel and the document stays a pure board. Live
  // documents that implement the contract populate this; the demo fixtures
  // remain the fallback so mock mode keeps its richer copy.
  const [postedOverview, setPostedOverview] = useState<CanvasOverviewContent | null>(null);
  // Render failures arrive over the same channel ({type:"sapiom-canvas:error",
  // title, reason}) — the app shows an actionable card instead of the
  // document's wall of text.
  const [postedError, setPostedError] = useState<{ title: string; reason: string } | null>(null);
  // The real workflow graph the document posts — the source for the step list.
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  // The steps list's accordion: which step row is expanded in place. A row's
  // full detail (Agent run, IO/logs, contract, lineage) renders INSIDE its
  // expansion — clicking a step is a dropdown, not a separate slide-in view.
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  // Which agent's integration snippets are disclosed on the deploy surface —
  // a path, not a flag, so the section closes itself when the subject changes.
  const [snippetsOpenFor, setSnippetsOpenFor] = useState<string | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as {
        type?: string;
        description?: unknown;
        stats?: unknown;
        notes?: unknown;
        badges?: unknown;
        legend?: unknown;
      } | null;
      if (!data || event.source !== frameRef.current?.contentWindow) return;
      if (data.type === "sapiom-canvas:overview") {
        setPostedOverview({
          description: typeof data.description === "string" ? data.description : "",
          stats: typeof data.stats === "string" ? data.stats : "",
          notes: Array.isArray(data.notes) ? data.notes.filter((n): n is string => typeof n === "string") : [],
          badges: Array.isArray(data.badges)
            ? data.badges.filter((b): b is string => typeof b === "string")
            : [],
          legend: Array.isArray(data.legend) ? data.legend.filter(isLegendItem) : [],
        });
      } else if (data.type === "sapiom-canvas:graph") {
        const nextGraph = parseCanvasGraph((data as { graph?: unknown }).graph);
        setGraph(nextGraph);
        const workflowPath = subjectPathRef.current;
        if (nextGraph && workflowPath) {
          onGraphChangeRef.current?.(workflowPath, nextGraph);
        }
        // THE reveal signal. Only a real render embeds the graph script that
        // posts this; the "preparing"/"pending" placeholders post nothing, so
        // this is what keeps the pane from opening on scaffolding. The
        // document loads even while the pane is collapsed (it is hidden with
        // `display:none`, never unmounted), so nothing is deferred — only the
        // reveal waits.
        onCanvasStateRef.current?.(true);
      } else if (data.type === "sapiom-canvas:node") {
        // A board pick: populate the bottom inspector, stay on the Canvas
        // tab. The Steps tab is the inspector's explicit "Open in Steps"
        // drill now, never a side effect of a click on the board.
        const id = (data as { id?: unknown }).id;
        if (typeof id === "string") setSelectedNodeId(id);
      } else if (data.type === "sapiom:node-click") {
        // Reverse click channel from the SERVED canvas board (the SVG DAG
        // rendered by canvas-svg.ts + canvas-run-state.ts). The served
        // board identifies nodes by step label (data-step-name), not the
        // graph node id, so resolve by label to get the stable id for the
        // inspector. Fall back to matching by id in case the label was used
        // directly as the id (older documents / degenerate labels).
        const stepName = (data as { stepName?: unknown }).stepName;
        if (typeof stepName === "string") {
          setGraph((g) => {
            if (g) {
              const matched =
                g.nodes.find((n) => n.label === stepName) ??
                g.nodes.find((n) => n.id === stepName) ??
                null;
              if (matched) setSelectedNodeId(matched.id);
            }
            return g;
          });
        }
      } else if (data.type === "sapiom-canvas:hit") {
        const overNode = typeof (data as { id?: unknown }).id === "string";
        setHoveredNode(overNode);
        hoveredNodeRef.current = overNode;
      } else if (data.type === "sapiom-canvas:size") {
        // The document's graph size + chrome insets — the fit-to-view input.
        const raw = data as {
          width?: unknown;
          height?: unknown;
          insetTop?: unknown;
          insetBottom?: unknown;
          insetX?: unknown;
        };
        if (
          typeof raw.width === "number" &&
          raw.width > 0 &&
          typeof raw.height === "number" &&
          raw.height > 0
        ) {
          setGraphSize({
            width: raw.width,
            height: raw.height,
            insetTop: typeof raw.insetTop === "number" && raw.insetTop >= 0 ? raw.insetTop : 0,
            insetBottom: typeof raw.insetBottom === "number" && raw.insetBottom >= 0 ? raw.insetBottom : 0,
            insetX: typeof raw.insetX === "number" && raw.insetX >= 0 ? raw.insetX : 0,
          });
        }
      } else if (data.type === "sapiom-canvas:error") {
        const raw = data as { title?: unknown; reason?: unknown };
        setPostedError({
          title: typeof raw.title === "string" ? raw.title : "",
          reason: typeof raw.reason === "string" ? raw.reason : "",
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  // A new document invalidates the previous one's overview/graph — and always
  // arrives with the panel open at its top level (never mid-drilldown).
  useEffect(() => {
    setPostedOverview(null);
    setPostedError(null);
    setGraph(null);
    setSelectedNodeId(null);
    setExpandedStepId(null);
    setOverviewOpen(true);
    setHoveredNode(false);
    hoveredNodeRef.current = false;
    // The old document's fit inputs and any manual view are meaningless for
    // the incoming one — start at rest and let its size message refit. Resetting
    // zoom/pan (not just restView) matters when the incoming doc posts NO size:
    // without it, a reload strands the previous zoom with the Fit button dead.
    setGraphSize(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRestView({ zoom: 1, x: 0, y: 0 });
    userAdjustedRef.current = false;
  }, [sessionId, reloadKey]);
  // The board-picked node the bottom inspector shows — validated against the
  // live graph so a stale id (document re-render dropped the step) renders
  // the overview, never a ghost step.
  const selectedNode =
    graph && selectedNodeId ? (graph.nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
  // Keep the board's is-selected ring in sync with the board pick; null clears it.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "sapiom-canvas:select", id: selectedNodeId },
      "*",
    );
  }, [selectedNodeId]);

  // Run-state bridge: post live run status into the served canvas board so its
  // SVG nodes animate (is-running / is-passed / is-failed / is-pending). The
  // served board listens for { type: "sapiom:run-state", steps, status, target }
  // (see packages/harness/src/core/canvas-run-state.ts: bootCanvasRunState /
  // applyRunStateToCanvas). We only post to a real served board — never when the
  // iframe is absent, in mock mode with no bundled doc, or while the frame is
  // still loading (the onLoad re-post below catches that case).
  const postRunStateToFrame = useCallback((): void => {
    if (!run || !runTarget) return;
    // Guard: only post when a board is actually mounted. The workflow-keyed
    // document is a real board too (same derivation), so it animates a run the
    // same way; a session-keyed one still needs its mock-doc gate.
    if (workflowSourcePath == null && sessionSourceId == null) return;
    if (sessionSourceId != null && isMockMode() && !hasMockCanvasDoc(sessionSourceId)) return;
    if (frameLoading) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: "sapiom:run-state", steps: run.steps, status: run.status, target: runTarget },
      "*",
    );
  }, [run, runTarget, workflowSourcePath, sessionSourceId, frameLoading]);

  useEffect(() => {
    postRunStateToFrame();
  }, [postRunStateToFrame]);

  const overview =
    postedOverview ??
    (isMockMode() && subjectWorkflow ? MOCK_CANVAS_OVERVIEWS[subjectWorkflow.path] : undefined);
  // Failed-task panels the user has explicitly dismissed (client-side only —
  // the task record itself stays in the server's list).
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(new Set());

  // Passed through to the served canvas so a kit-based template can match the
  // app's current theme instead of always rendering dark. Legacy canvases
  // that don't read the param are unaffected.
  useEffect(() => subscribeTheme(setTheme), []);

  // Probe once per session for pre-existing content — the agent may have written
  // it in an earlier turn, before this pane was around to catch a reload event.
  // Skipped entirely while the subject is served by the workflow-keyed route:
  // `/canvas/:sessionId/` resolves by the session's BINDING, so its answer is
  // about a different agent and would decide this pane's content for it.
  useEffect(() => {
    if (workflowSourcePath != null) return;
    setFrameLoading(true);
    if (!sessionId) {
      setHasGeneratedContent(false);
      onCanvasStateRef.current?.(false);
      return;
    }
    // Mock mode ships no live probe. A mock session that ships a bundled canvas
    // doc (public/canvas/<id>/, i.e. hasMockCanvasDoc) renders its board on
    // FIRST PAINT — the demo opens on its seeded agent's live board, not an
    // empty pane. Sessions without a bundled doc stay honestly empty and never
    // mount an iframe (the invariant smoke.spec guards); no fabricated docs.
    if (isMockMode()) {
      const has = hasMockCanvasDoc(sessionId);
      setHasGeneratedContent(has);
      // Same rule as the live probe: absence is announced, presence waits for
      // the graph message. The bundled fixture posts one (public/canvas/
      // sess-boot/index.html), so the demo still opens on its seeded board —
      // and the e2e suite exercises the real gate rather than a shortcut.
      if (!has) onCanvasStateRef.current?.(false);
      return;
    }
    setHasGeneratedContent(false);
    let cancelled = false;
    setProbing(true);
    fetch(`/canvas/${sessionId}/`, { method: "HEAD" })
      .then((res) => {
        if (cancelled) return;
        // Mount the iframe when something is servable, but only ever announce
        // the ABSENCE of content here. A 200 covers the real board, the
        // "preparing" placeholder AND the server's "Rendering agent diagram…"
        // pending document — indistinguishable to a HEAD probe. The reveal is
        // the graph message's job; hiding an empty pane is still this one's.
        setHasGeneratedContent(res.ok);
        if (!res.ok) onCanvasStateRef.current?.(false);
      })
      .catch(() => {})
      .finally(() => !cancelled && setProbing(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId, workflowSourcePath]);

  /**
   * The workflow-keyed board (IA-01) — the pane's document whenever the active
   * session is not bound to the subject, including for an agent that has never
   * hosted a session.
   *
   * Fetched, not framed: the route is behind the `X-Harness-Token` middleware,
   * so an `<iframe src>` could not authenticate. The JSON carries `document`
   * (byte-identical to what a bound session's canvas serves) and `graph`; the
   * document is what renders, via `srcdoc`.
   */
  const [workflowBoard, setWorkflowBoard] = useState<WorkflowBoard | null>(null);
  /** Bumped by any render landing anywhere, so a board read from the route
   *  refreshes instead of showing a snapshot from before the render. */
  const [workflowReloadSeq, setWorkflowReloadSeq] = useState(0);
  const loadWorkflowGraphRef = useRef(loadWorkflowGraph);
  loadWorkflowGraphRef.current = loadWorkflowGraph;
  useEffect(() => {
    if (workflowSourcePath == null) {
      setWorkflowBoard(null);
      return;
    }
    // `probing` is owned by whichever source is reading. Leaving it set when
    // this effect is torn down mid-flight stranded the loading spinner over an
    // otherwise-usable pane for the rest of the session — binding the subject
    // (which flips the source to session-keyed) does exactly that.
    let cancelled = false;
    setFrameLoading(true);
    setProbing(true);
    const settle = setTimeout(() => {
      loadWorkflowGraphRef
        .current(workflowSourcePath)
        .then((res) => {
          if (cancelled) return;
          setWorkflowBoard({
            path: workflowSourcePath,
            status: res.status,
            document: res.document,
            reason: res.reason,
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // Each of these is a different sentence to the reader, so none of
          // them collapse into one generic failure. A 404 means "not a
          // registered agent" and nothing else; a 400 means the path itself was
          // refused; anything else is the request not landing at all.
          const status =
            err instanceof ApiError && err.status === 404
              ? "notRegistered"
              : err instanceof ApiError && err.status === 400
                ? "rejected"
                : "unreachable";
          setWorkflowBoard({
            path: workflowSourcePath,
            status,
            document: null,
            reason: err instanceof Error ? err.message : null,
          });
        })
        .finally(() => {
          if (!cancelled) setProbing(false);
        });
    }, WORKFLOW_BOARD_SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(settle);
      setProbing(false);
    };
  }, [workflowSourcePath, workflowReloadSeq]);

  useEffect(() => {
    if (lastMessage?.type === "canvas.reload") setWorkflowReloadSeq((seq) => seq + 1);
  }, [lastMessage]);

  useEffect(() => {
    if (!lastMessage || !sessionId) return;
    if (lastMessage.type === "canvas.reload" && lastMessage.harnessSessionId === sessionId) {
      // Mock mode ships REAL documents only for MOCK_CANVAS_SESSIONS (files
      // under public/canvas/<id>/). For any other mock session the iframe
      // URL would be the static host's 404 page — never mount it; the pane
      // keeps its honest empty state instead.
      if (isMockMode() && !hasMockCanvasDoc(sessionId)) return;
      // Mount and swap the document, but do NOT announce it: a canvas write is
      // also how the "preparing" placeholder lands, and announcing here opened
      // the pane on setup scaffolding. The reveal is announced from the graph
      // message below, once the loaded document proves it has a board.
      setHasGeneratedContent(true);
      setFrameLoading(true);
      setReloadKey((key) => key + 1);
    }
  }, [lastMessage, sessionId]);

  // The server resolves the canvas root by the session's CURRENT binding, so
  // a bind/unbind changes what the same URL serves — refetch immediately
  // instead of waiting for the render write's canvas.reload to arrive. A new
  // document also invalidates the old view transform.
  const subjectPath = subjectWorkflow?.path ?? null;
  useEffect(() => {
    setFrameLoading(true);
    setReloadKey((key) => key + 1);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRestView({ zoom: 1, x: 0, y: 0 });
    userAdjustedRef.current = false;
  }, [subjectPath]);

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
      (task.workflowPath == null || task.workflowPath === subjectPath),
  );
  // A "describe" run is a HIDDEN background pass — its only surface is the
  // overview button's loading state (below), never the board activity/overlay
  // or the failure takeover. Every other background task keeps its board
  // treatment, so it's filtered out of runningTask / latestFinished here.
  const describeRunning = sessionTasks.some(
    (task) => task.status === "running" && task.macroId === "describe",
  );
  const runningTask =
    sessionTasks.find((task) => task.status === "running" && task.macroId !== "describe") ?? null;
  const latestFinished = sessionTasks
    .filter((task) => task.status !== "running" && task.macroId !== "describe")
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  const failedTask =
    !runningTask && latestFinished?.status === "failed" && !dismissedTaskIds.has(latestFinished.id)
      ? latestFinished
      : null;
  const retryMacro = failedTask ? (macros.find((macro) => macro.id === failedTask.macroId) ?? null) : null;
  const visualizeMacro = macros.find((macro) => macro.id === "visualize") ?? null;

  // Content is on screen and loadable — the only state where panel-level
  // view actions (expand) make sense.
  // Mock hard gate, derived (not state): only sessions with a bundled demo
  // document may EVER mount the iframe — state can go stale for one render
  // across a session switch, and on the static Pages build a wrong URL is
  // GitHub's 404 page rendered inside the pane.
  const sessionHasServableDoc =
    sessionSourceId != null && (!isMockMode() || hasMockCanvasDoc(sessionSourceId));
  /**
   * The workflow-keyed answer for the CURRENT subject. Path-checked, so a reply
   * that arrives after the selection moved on is ignored rather than drawn
   * under the new agent's name.
   */
  const boardFromRoute =
    workflowSourcePath != null && workflowBoard?.path === workflowSourcePath
      ? workflowBoard
      : null;
  /**
   * `preparing` mounts the frame alongside `ok`: it is the calm "installing
   * dependencies" placeholder the server renders for a fresh scaffold, and
   * treating it as a failure would show an esbuild message to someone who has
   * just created an agent. It posts no graph, so the reveal gate still holds.
   */
  const routeFrameDocument =
    boardFromRoute != null &&
    (boardFromRoute.status === "ok" || boardFromRoute.status === "preparing") &&
    boardFromRoute.document != null
      ? boardFromRoute.document
      : null;
  const showsContent =
    source.kind === "agent"
      ? routeFrameDocument != null
      : hasGeneratedContent && sessionHasServableDoc;

  // The observability header for the Steps surface: a deploy landing (if one is
  // in flight/just landed) and the run summary card (if a run has been
  // observed). Rendered at the top of every steps-surface path so Run/Test/Deploy
  // each show progress + the relevant final data the moment the pane opens here.
  //
  // It is also where the integration snippets now live. "How do I call this"
  // is a post-deploy question, asked once — a permanent tab was too much IA for
  // it, and the honest place to answer it is next to the deploy that made the
  // agent callable.
  //
  // The section belongs to any LINKED agent, not only a ready one, and that is
  // deliberate: the deploy banner's "Trigger from your code" appears the moment
  // the phase reaches `ready`, which is set BEFORE the workflow refresh that
  // updates `activeBuildRunStatus` (`use-harness-state.ts`). Gated on
  // runnability alone, a click in that window switched to Steps and showed
  // nothing at all — a live control with no target. So the section exists and
  // says WHY there is nothing to copy yet, which is what the removed tab's four
  // empty states were for. A draft (no `definitionId`) genuinely has nothing to
  // say and gets no section.
  const snippetSubject = subjectWorkflow?.definitionId != null ? subjectWorkflow : null;
  const snippetsRunnable = snippetSubject != null && isWorkflowRunnable(snippetSubject);
  // Same vocabulary the removed Code tab used, minus its local-deploy-error
  // input: an error still in flight is already reported by the banner above.
  const snippetsPendingReason =
    snippetSubject == null || snippetsRunnable
      ? null
      : workflowDeploymentState(snippetSubject, null) === "building"
        ? `${snippetSubject.name} is linked and building. The snippets appear once the cloud build is ready.`
        : `${snippetSubject.name} is linked to Sapiom, but Studio cannot confirm a ready cloud build. Deploy it before integrating.`;
  // Keyed by path rather than a boolean, so the disclosure does not stay open
  // over the NEXT agent you select — that agent has different snippets, and a
  // section the user never opened would be showing them.
  const snippetsOpen = snippetSubject != null && snippetsOpenFor === snippetSubject.path;
  const stepsHeader = (
    <>
      {deployState && (
        <DeployStatusBanner
          deployState={deployState}
          workflow={subjectWorkflow}
          onDismiss={onDismissDeploy}
          onOpenCode={
            // Null while there is no section to jump to — see the banner's own
            // note. This is the pairing, stated in one place.
            snippetSubject
              ? () => {
                  setSnippetsOpenFor(snippetSubject.path);
                  onOpenCode();
                }
              : null
          }
        />
      )}
      {snippetSubject && (
        <section className="steps-snippets" data-testid="steps-snippets">
          <button
            type="button"
            className="steps-snippets-toggle"
            data-testid="steps-snippets-toggle"
            aria-expanded={snippetsOpen}
            onClick={() =>
              setSnippetsOpenFor(snippetsOpen ? null : snippetSubject.path)
            }
          >
            <Icon name="Code" size={13} />
            <span className="steps-snippets-title">Trigger from your code</span>
            <Icon name={snippetsOpen ? "ChevronUp" : "ChevronDown"} size={13} />
          </button>
          {snippetsOpen &&
            (snippetsPendingReason ? (
              <p className="steps-snippets-pending" data-testid="steps-snippets-pending">
                {snippetsPendingReason}
              </p>
            ) : (
              <SnippetPanel
                key={snippetSubject.path}
                boundWorkflow={snippetSubject}
                agentsBaseUrl={agentsBaseUrl}
              />
            ))}
        </section>
      )}
    </>
  );

  /**
   * The honest state for a workflow-keyed board that is not a graph.
   *
   * Four distinct sentences, not one generic failure, because each one asks a
   * different thing of the reader: `preparing` needs nothing (it mounts the
   * frame above), `empty` needs a render, `error` names what broke, and
   * `notRegistered` says the rail is listing a path the registry no longer
   * knows. Collapsing them was how a fresh scaffold came to show an esbuild
   * message to someone who had just created an agent.
   */
  const routeEmptyState =
    boardFromRoute == null || routeFrameDocument != null
      ? null
      : boardFromRoute.status === "empty"
        ? {
            testId: "canvas-empty-route-empty",
            icon: "Workflow",
            title: surface === "steps" ? "No steps yet" : "Nothing rendered yet",
            body:
              boardFromRoute.reason ??
              "This agent has no diagram yet; it is generated from its code.",
          }
        : boardFromRoute.status === "error"
          ? {
              testId: "canvas-empty-route-error",
              icon: "TriangleAlert",
              title: "Couldn't read this agent's diagram",
              body: boardFromRoute.reason ?? "The diagram extraction failed.",
            }
          : boardFromRoute.status === "notRegistered"
            ? {
                testId: "canvas-empty-route-unregistered",
                icon: "Radio",
                title: "Studio doesn't know this agent",
                body:
                  "The path is not a registered agent — rescan the project to pick it up again.",
              }
            : {
                testId: "canvas-empty-route-unavailable",
                icon: "Radio",
                title: "Couldn't load this agent's board",
                body: boardFromRoute.reason ?? "The harness didn't answer.",
              };

  return (
    <aside className="canvas-pane" {...trackingAttrs({ surface: "canvas" })}>
      {subjectWorkflow && !overviewActive && (
        <WorkflowActionsHeader
          workflow={subjectWorkflow}
          detailStep={null}
          onBack={() => {}}
          onAskAgent={onInjectPrompt}
          surface={surface}
          stepsSummary={graph && graph.nodes.length > 0 ? formatGraphCounts(graph) : null}
          run={run}
          runTarget={runTarget}
          runs={runs}
          onSelectRun={onSelectRun}
        />
      )}

      {/* Early-return states are surface-aware: the Steps tab talks about
          steps (read from the visualized workflow), the Canvas tab keeps its
          board copy. Both "no steps" states share one title; the hint names
          the cause. */}
      {overviewActive || source.kind === "none" ? (
        /* Nothing is the subject — a project or folder row, the create-new
           draft, or a review. There used to be a "No running session for X"
           state here as well; with IA-01's workflow-keyed route an agent with
           no session HAS a board, so an absence of sessions is no longer an
           absence of subject (SAP-2931). */
        // Reads identically to a fresh install: nothing is on display, so no
        // Visualize CTA and no stale copy.
        surface === "steps" ? (
          <EmptyState
            className="canvas-empty"
            icon="Radio"
            title="No session"
            body="Start a session to see the agent's steps here."
          />
        ) : (
          <EmptyState
            className="canvas-empty"
            icon="Radio"
            title="No session"
            body="Start a session to see its canvas here."
          />
        )
      ) : failedTask ? (
        <div className="canvas-task-failed" data-testid="canvas-task-failed">
          <p className="canvas-task-title">
            <Icon name="TriangleAlert" size={14} /> {failedTask.label} failed.
          </p>
          {failedTask.errorTail && <pre className="canvas-task-error">{failedTask.errorTail}</pre>}
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
      ) : runningTask && !showsContent ? (
        <div className="canvas-task-activity" data-testid="canvas-task-activity">
          <span className="canvas-task-icon" aria-hidden="true">
            <Icon name="Workflow" size={20} />
          </span>
          <div className="canvas-task-title">
            <span>{runningTask.label} is running…</span>
          </div>
          {runningTask.statusLines.length > 0 && (
            <ul className="canvas-task-lines" data-testid="canvas-task-lines">
              {runningTask.statusLines.slice(-ACTIVITY_LINES_SHOWN).map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          )}
          <p className="canvas-empty-hint">
            Running as a background task, so your session stays free. The canvas reloads here when it finishes.
          </p>
        </div>
      ) : probing ? (
        <div className="canvas-loading" data-testid="canvas-loading">
          <span className="canvas-task-spinner" aria-hidden="true" />
          <p className="canvas-empty-hint">{surface === "steps" ? "Loading steps…" : "Loading canvas…"}</p>
        </div>
      ) : !showsContent && surface === "steps" && (run || deployState || snippetSubject) ? (
        /* No diagram yet, but the surface still has something true to say: a
           run was observed, a deploy is landing, or the agent has a ready cloud
           build and therefore snippets to copy.
           `snippetSubject` is in that list because the alternative was losing
           "how do I call this" while tidying the IA: a deployed agent whose
           board has never rendered would fall straight through to "No steps
           yet", and its snippets — the whole reason the Code tab is safe to
           remove — would be unreachable. The empty state is kept BELOW the
           header rather than replaced, so the honest "no steps" claim survives
           alongside the things that are not steps. */
        <div className="canvas-frame-wrap" data-view="steps">
          <div className="canvas-steps-surface" data-testid="canvas-steps-surface">
            {stepsHeader}
            {run ? (
              <RunWorkspace
                run={run}
                target={runTarget}
                workflow={subjectWorkflow}
                focus={expanded}
                onToggleFocus={onToggleExpanded}
                onAskAgent={onInjectPrompt}
                onInspectionOpened={() => trackProduct("run.inspection_opened", { target: runTarget ?? "unknown" })}
                onArtifactViewed={() => trackProduct("run.artifact_viewed", { target: runTarget ?? "unknown" })}
                onDashboardOpened={() => trackProduct("run.dashboard_opened", { target: runTarget ?? "unknown" })}
              />
            ) : deployState ? null : (
              <EmptyState
                className="canvas-empty"
                testId={routeEmptyState?.testId ?? "canvas-empty-steps"}
                icon={routeEmptyState?.icon ?? "Workflow"}
                title={routeEmptyState?.title ?? "No steps yet"}
                body={
                  routeEmptyState?.body ??
                  "Steps are read from the bound agent's diagram — generated automatically from its code."
                }
              />
            )}
          </div>
        </div>
      ) : routeEmptyState ? (
        <EmptyState
          className="canvas-empty"
          testId={routeEmptyState.testId}
          icon={routeEmptyState.icon}
          title={routeEmptyState.title}
          body={routeEmptyState.body}
        />
      ) : !showsContent && sessionExited ? (
        /* nothing was generated and the session is dead — a render here would
           target a pty that no longer exists. */
        <EmptyState
          className="canvas-empty"
          testId="canvas-empty-exited"
          icon="History"
          title="Session ended"
          body={`Resume the session to see ${surface === "steps" ? "the agent's steps" : "the agent's diagram"} here.`}
        />
      ) : !showsContent ? (
        /* Header claim + one supporting line — no action. The diagram is
           generated deterministically from the bound workflow (no AI),
           automatically on bind/start and on every code change, so there's
           nothing to trigger by hand; an unbound session simply has nothing
           to show yet. */
        <EmptyState
          className="canvas-empty"
          icon="Workflow"
          title={surface === "steps" ? "No steps yet" : "Nothing generated yet"}
          body={
            surface === "steps"
              ? "Steps are read from the bound agent's diagram — generated automatically from its code."
              : "Generated automatically from the bound agent; it refreshes when the code changes."
          }
        />
      ) : (
        <div
          className={"canvas-frame-wrap" + (expanded && surface === "board" ? " is-expanded" : "")}
          data-view={surface === "board" ? "board" : "steps"}
        >
          {/* The active surface: the board on the Canvas tab, the steps list on
              the Steps tab. A step's detail opens inline in its list row (see
              CanvasStepsList), so there is no separate detail pane. The board
              stays MOUNTED under the steps surface: the iframe is the graph's
              source of truth. */}
          <div className="canvas-slide-track">
          <div className="canvas-slide-pane">
          <div className={"canvas-visual" + (surface === "steps" ? " is-offstage" : "")}>
          <div className="canvas-view-controls" data-testid="canvas-view-controls">
            <button
              className="theme-toggle"
              data-testid="canvas-zoom-out"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={zoom <= minZoom + 0.001}
              onClick={() => {
                userAdjustedRef.current = true;
                setZoom((z) => Math.max(minZoom, Math.round((z - 0.25) * 100) / 100));
              }}
            >
              <Icon name="ZoomOut" size={14} />
            </button>
            <button
              className="theme-toggle canvas-zoom-reset"
              data-testid="canvas-zoom-reset"
              aria-label="Reset zoom"
              title="Reset zoom"
              disabled={zoom === 1}
              onClick={() => {
                userAdjustedRef.current = true;
                setZoom(1);
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="theme-toggle"
              data-testid="canvas-zoom-in"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={zoom >= 2}
              onClick={() => {
                userAdjustedRef.current = true;
                setZoom((z) => Math.min(2, Math.round((z + 0.25) * 100) / 100));
              }}
            >
              <Icon name="ZoomIn" size={14} />
            </button>
            <button
              className="theme-toggle"
              data-testid="canvas-fit"
              aria-label="Fit to view"
              title="Fit to view"
              disabled={zoom === restView.zoom && pan.x === restView.x && pan.y === restView.y}
              onClick={fitView}
            >
              <Icon name="Frame" size={14} />
            </button>
          </div>
          {expanded && (
            <button
              className="macro-icon-btn canvas-expand-exit"
              data-testid="canvas-expand-exit"
              aria-label="Exit expanded canvas"
              title="Exit expanded canvas (Esc)"
              onClick={onToggleExpanded}
            >
              <Icon name="Minimize2" size={14} />
            </button>
          )}
          {(frameLoading || skeletonFading) && (
            <div
              className={"canvas-skeleton canvas-loading--overlay" + (frameLoading ? "" : " is-fading")}
              data-testid="canvas-loading"
              role="status"
              aria-label="Rendering diagram"
            >
              <div className="canvas-skeleton-block canvas-skeleton-title" />
              <div className="canvas-skeleton-row">
                <div className="canvas-skeleton-block" />
                <div className="canvas-skeleton-block" />
              </div>
              <div className="canvas-skeleton-row">
                <div className="canvas-skeleton-block" />
                <div className="canvas-skeleton-block" />
                <div className="canvas-skeleton-block" />
              </div>
              <div className="canvas-skeleton-block canvas-skeleton-wide" />
            </div>
          )}
          {postedError && (
            <div className="canvas-render-error" data-testid="canvas-render-error">
              <span className="canvas-error-icon" aria-hidden="true">
                <Icon name="TriangleAlert" size={20} />
              </span>
              <div className="canvas-task-title">Render failed</div>
              <p className="canvas-error-summary">
                {(() => {
                  const reason = postedError.reason.trim();
                  if (reason.length < 4) return "The agent graph could not be extracted. Open the terminal for details.";
                  return reason.includes(": ") ? reason.slice(reason.indexOf(": ") + 2).split(". ")[0] : reason;
                })()}
              </p>
              <div className="canvas-error-actions">
                <button
                  className="btn-primary"
                  data-testid="canvas-error-fix"
                  onClick={() =>
                    onInjectPrompt(
                      `The canvas render for ${postedError.title || "this agent"} failed: ${postedError.reason} Fix the project so the agent graph extracts cleanly.`,
                    )
                  }
                >
                  Ask coding agent to fix
                </button>
                <button
                  className="btn-ghost"
                  data-testid="canvas-error-retry"
                  onClick={() => {
                    if (visualizeMacro) {
                      onRunMacro(visualizeMacro);
                    } else {
                      skeletonHoldUntilRef.current = Date.now() + 900;
                      setFrameLoading(true);
                      setReloadKey((key) => key + 1);
                    }
                  }}
                >
                  Retry
                </button>
              </div>
              <details className="canvas-error-details">
                <summary>Details</summary>
                <pre>{postedError.reason.trim().length >= 4 ? postedError.reason : "The rendered document reported a failure without details. Re-render the diagram or check the terminal."}</pre>
              </details>
            </div>
          )}
          {runningTask && (
            <div
              className="canvas-task-activity canvas-task-activity--overlay"
              data-testid="canvas-task-activity"
            >
              <span className="canvas-task-icon" aria-hidden="true">
                <Icon name="Workflow" size={20} />
              </span>
              <div className="canvas-task-title">
                <span>{runningTask.label} is running…</span>
              </div>
              {runningTask.statusLines.length > 0 && (
                <ul className="canvas-task-lines" data-testid="canvas-task-lines">
                  {runningTask.statusLines.slice(-ACTIVITY_LINES_SHOWN).map((line, index) => (
                    <li key={`${index}-${line}`}>{line}</li>
                  ))}
                </ul>
              )}
              <p className="canvas-empty-hint">
                Running as a background task, so your session stays free. The canvas reloads here when it finishes.
              </p>
            </div>
          )}
          {/* Real mode: the harness server (or Vite proxy) serves /canvas/…/.
              Mock mode: the demo doc is a static file under public/ — named
              explicitly because Vite's dev server doesn't resolve directory
              indexes there (the built Pages site does either way). */}
          {/* Reopen affordance only — the dismiss lives in the overview
              panel's own header, so no control ever floats detached over
              the board. Hidden while a pick has the inspector open
              (the panel is already showing). */}
          {overview && !overviewOpen && !selectedNode && (
            <button
              className="theme-toggle canvas-overview-open"
              data-testid="canvas-overview-toggle"
              aria-label="Show agent overview"
              data-tooltip="Show agent overview"
              onClick={() => setOverviewOpen(true)}
            >
              i
            </button>
          )}
          {/* Chat toggle — the ask/macros panel is standalone and closed by
              default; independent of the info panel (both can be open). */}
          {surface === "board" && (
            <button
              className={"theme-toggle canvas-chat-toggle" + (chatOpen ? " is-active" : "")}
              data-testid="canvas-chat-toggle"
              aria-label={chatOpen ? "Close chat" : "Open chat"}
              data-tooltip="Chat — ask about this agent or the selected step"
              onClick={() => setChatOpen((c) => !c)}
            >
              <Icon name="MessageSquare" size={14} />
            </button>
          )}
          <iframe
            ref={frameRef}
            key={
              routeFrameDocument != null
                ? `wf:${workflowSourcePath}:${workflowReloadSeq}`
                : `${sessionId}:${reloadKey}`
            }
            className="canvas-iframe"
            /* Two entry points, one element. The session-keyed board is a URL
               (`/canvas/:sessionId/` is mounted unauthenticated for exactly
               this reason); the workflow-keyed one CANNOT be a `src` — it sits
               behind the `X-Harness-Token` middleware, which an iframe cannot
               carry — so its document arrives as JSON and renders via `srcdoc`.
               The theme rides in a query string for the first and an appended
               script for the second, which has no URL to read. */
            {...(routeFrameDocument != null
              ? { srcDoc: withFrameTheme(routeFrameDocument, theme) }
              : {
                  src: `${import.meta.env.BASE_URL}canvas/${sessionId}/${isMockMode() ? "index.html" : ""}?theme=${theme}`,
                })}
            sandbox="allow-scripts"
            // The board is navigated only through the app's zoom/fit/pan
            // controls (the view is posted INTO the document); it must never
            // show native scrollbars. Sandboxed, it is cross-origin, so this
            // element-level attribute — not CSS on the frame — is the one thing
            // that suppresses the inner document's scrollbars, and it covers
            // real renders as well as the mock board.
            scrolling="no"
            onLoad={() => {
              handleFrameLoaded();
              // A fresh document starts at identity; re-sync the current view.
              frameRef.current?.contentWindow?.postMessage(
                { type: "sapiom-canvas:view", zoom, x: pan.x, y: pan.y },
                "*",
              );
              // Re-apply any active run state so a reload / late mount shows
              // the current animation immediately without waiting for the next
              // run update. frameLoading is still true at this point (it clears
              // after the hold timer), so call the raw post directly.
              if (run && runTarget && (routeFrameDocument != null || sessionHasServableDoc)) {
                frameRef.current?.contentWindow?.postMessage(
                  { type: "sapiom:run-state", steps: run.steps, status: run.status, target: runTarget },
                  "*",
                );
              }
            }}
            // A failed load settles the skeleton too, so the overlay never
            // strands opaquely over the board.
            onError={settleFrameLoaded}
          />
          {/* Gesture surface over the sandboxed document: drag pans, wheel
              zooms, double-click fits. The doc itself is a render target
              (its own inputs live in the app chrome), so capturing the
              pointer here costs nothing. */}
          <div
            ref={panLayerRef}
            className={"canvas-pan-layer" + (panning ? " is-panning" : "")}
            data-testid="canvas-pan-layer"
            data-over-node={hoveredNode && !panning ? "true" : undefined}
            onPointerDown={startPan}
            onPointerMove={forwardHover}
            onPointerLeave={clearHover}
            onDoubleClick={fitView}
          />
          </div>
          {surface === "steps" && (
            <div className="canvas-steps-surface" data-testid="canvas-steps-surface">
              {stepsHeader}
              {run ? (
                <RunWorkspace
                  run={run}
                  target={runTarget}
                  workflow={subjectWorkflow}
                  focus={expanded}
                  onToggleFocus={onToggleExpanded}
                  onAskAgent={onInjectPrompt}
                  onInspectionOpened={() => trackProduct("run.inspection_opened", { target: runTarget ?? "unknown" })}
                  onArtifactViewed={() => trackProduct("run.artifact_viewed", { target: runTarget ?? "unknown" })}
                  onDashboardOpened={() => trackProduct("run.dashboard_opened", { target: runTarget ?? "unknown" })}
                />
              ) : graph && graph.nodes.length > 0 ? (
                <CanvasStepsList
                  graph={graph}
                  run={run}
                  runTarget={runTarget}
                  workflows={workflows}
                  onOpenWorkflow={onOpenWorkflow}
                  onAskAgent={onInjectPrompt}
                  expandedId={expandedStepId}
                  onToggle={(id) => setExpandedStepId((cur) => (cur === id ? null : id))}
                />
              ) : (
                /* Same title as the pre-render empty state; the hint names
                   this cause (a rendered canvas that posted no graph). */
                <EmptyState
                  className="canvas-empty"
                  icon="Workflow"
                  title="No steps yet"
                  body="This diagram has no step graph. It regenerates automatically from the bound agent — check the terminal if it never appears."
                />
              )}
            </div>
          )}
          {/* Bottom panel: the workflow overview, or \u2014 while a board pick
              holds a selection \u2014 that step's live inspector. A selection
              shows the panel even when the overview was collapsed or the
              document posted no overview chrome. */}
          {surface === "board" && ((overview && overviewOpen) || selectedNode) && (
            <CanvasOverviewPanel
              overview={overview ?? null}
              selectedNode={selectedNode}
              graph={graph}
              run={run}
              workflows={workflows}
              onOpenWorkflow={onOpenWorkflow}
              onOpenSteps={() => {
                // Board pick → Steps tab with that step's row already expanded
                // (the detail is inline in the list now, not a separate view).
                if (selectedNodeId) setExpandedStepId(selectedNodeId);
                onOpenSteps();
              }}
              onDeselect={() => setSelectedNodeId(null)}
              onCollapse={() => setOverviewOpen(false)}
              onDescribeWithAI={
                subjectWorkflow && sessionId && !sessionExited
                  ? () => onDescribeWorkflow(subjectWorkflow)
                  : undefined
              }
              describing={describeRunning}
            />
          )}
          {/* Standalone chat panel — independent of the info panel above; shows
              whenever the 💬 toggle is on and a session can receive the inject.
              Targets the selected step, or a general ask when none is selected. */}
          {surface === "board" && chatOpen && (
            <CanvasChatPanel
              node={selectedNode}
              run={run}
              onInjectPrompt={onInjectPrompt}
              onClose={() => setChatOpen(false)}
            />
          )}
          </div>
          </div>
        </div>
      )}
    </aside>
  );
}
