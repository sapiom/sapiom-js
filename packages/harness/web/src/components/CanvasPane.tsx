import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { BackgroundTask, BusMessage, MacroDef, RunView, WorkflowInfo } from "@shared/types";

import { isMockMode } from "../lib/api";
import { MOCK_CANVAS_OVERVIEWS, hasMockCanvasDoc } from "../lib/mock-data";
import { findVisualizeMacro, macroDisabledReason } from "../lib/macro-gating";
import { getTheme, subscribeTheme } from "../lib/theme";
import { track } from "../lib/track";
import { type CanvasGraph, formatGraphCounts, parseCanvasGraph } from "../lib/canvas-graph";
import type { ObservedRun, RunTarget } from "../lib/use-harness-state";
import { CanvasOverviewPanel } from "./CanvasOverviewPanel";
import { CanvasStepDetail, CanvasStepsList, RunStepsList } from "./CanvasStepDetail";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { WorkflowActionsHeader } from "./WorkflowActionsHeader";

/** How many of a running task's trailing status lines the activity view shows. */
const ACTIVITY_LINES_SHOWN = 8;

interface CanvasPaneProps {
  sessionId: string | null;
  lastMessage: BusMessage | null;
  boundWorkflow: WorkflowInfo | null;
  /** Set when an agent is open with no live session in its workspace: the
   *  pane shows the honest "no session for <name>" state instead of another
   *  agent's board (the canvas is served per session, so an
   *  unsessioned agent has no board to render). */
  noSessionAgent?: string | null;
  activeSessionId: string | null;
  /** the overview/welcome panel owns the center pane — no session is
   *  displayed, so the canvas shows the fresh-install "start a session"
   *  state instead of the previous session's empty state and CTA. */
  overviewActive: boolean;
  /** the displayed session has exited — Visualize can't do anything,
   *  so the empty state swaps to a resume invitation. */
  sessionExited: boolean;
  macros: MacroDef[];
  /** All background tasks (any session) — filtered to `sessionId` here. */
  tasks: BackgroundTask[];
  onRunMacro: (macro: MacroDef) => void;
  /** Sends a prompt to the active session's agent (used by the render-error
   *  state's one-click fix). */
  onInjectPrompt: (text: string) => void;
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
  /** Registry workflows — launched-workflow nodes navigate to theirs. */
  workflows: WorkflowInfo[];
  /** Binds and switches to another workflow (App's handleBindWorkflow) —
   *  navigating to a launched workflow is an explicit act on it, so it
   *  rebinds, same as running a macro against it. */
  onOpenWorkflow: (path: string) => void;
}

export function CanvasPane({
  sessionId,
  lastMessage,
  boundWorkflow,
  noSessionAgent = null,
  activeSessionId,
  overviewActive,
  sessionExited,
  macros,
  tasks,
  onRunMacro,
  onInjectPrompt,
  surface,
  onOpenSteps,
  run,
  runTarget,
  runs,
  onSelectRun,
  workflows,
  onOpenWorkflow,
}: CanvasPaneProps): JSX.Element {
  const [hasGeneratedContent, setHasGeneratedContent] = useState(false);
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
  const settleFrameLoaded = (): void => {
    setFrameLoading(false);
    setSkeletonFading(true);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => setSkeletonFading(false), 360);
  };
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
  // View controls for the rendered document: zoom scales the iframe ELEMENT
  // (with size compensation) — the sandboxed doc is never touched; expand
  // lifts the frame to a fixed overlay without remounting it, so the
  // document (and any running enrichment) survives the toggle.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panLayerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const clampZoom = (z: number): number => Math.min(3, Math.max(0.25, Math.round(z * 100) / 100));
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
    // Fit only ever shrinks (enlarging a small graph past 100% just blurs
    // it) and never dips below the zoom widget's own floor.
    const fitted = Math.min(1, availWidth / graphSize.width, availHeight / graphSize.height);
    return { zoom: Math.max(0.5, Math.round(fitted * 100) / 100), x: 0, y: 0 };
  }, [graphSize]);

  const fitView = useCallback((): void => {
    const fit = computeFit() ?? { zoom: 1, x: 0, y: 0 };
    // An explicit fit hands the view back to auto-follow: subsequent pane
    // resizes keep it fitted until the user moves the view again.
    userAdjustedRef.current = false;
    setZoom(fit.zoom);
    setPan({ x: fit.x, y: fit.y });
    setRestView(fit);
  }, [computeFit]);

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

  const [expanded, setExpanded] = useState(false);
  // The board-picked step whose detail the bottom inspector shows. Separate
  // from detailStepId (the Steps tab's full-pane drill): a pick stays on the
  // Canvas tab now, populating the panel below the board in real time.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Escape unwinds one layer per press: an open inspector selection clears
  // first; only then does the expanded overlay exit (its own exit button
  // still works either way).
  useEffect(() => {
    if (!expanded && selectedNodeId == null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (selectedNodeId != null) setSelectedNodeId(null);
      else setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, selectedNodeId]);
  const [overviewOpen, setOverviewOpen] = useState(true);
  // Overview contract: a rendered document may post its chrome content
  // ({type:"sapiom-canvas:overview", description, stats, notes[]}) so the APP
  // renders the overview panel and the document stays a pure board. Live
  // documents that implement the contract populate this; the demo fixtures
  // remain the fallback so mock mode keeps its richer copy.
  const [postedOverview, setPostedOverview] = useState<{
    description: string;
    stats: string;
    notes: string[];
  } | null>(null);
  // Render failures arrive over the same channel ({type:"sapiom-canvas:error",
  // title, reason}) — the app shows an actionable card instead of the
  // document's wall of text.
  const [postedError, setPostedError] = useState<{ title: string; reason: string } | null>(null);
  // The real workflow graph the document posts — the source for the step
  // drill-down. `detailStepId` is the step currently drilled into (null = the
  // overview list).
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  const [detailStepId, setDetailStepId] = useState<string | null>(null);
  // The steps list's accordion: which step row is expanded in place.
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as {
        type?: string;
        description?: unknown;
        stats?: unknown;
        notes?: unknown;
      } | null;
      if (!data || event.source !== frameRef.current?.contentWindow) return;
      if (data.type === "sapiom-canvas:overview") {
        setPostedOverview({
          description: typeof data.description === "string" ? data.description : "",
          stats: typeof data.stats === "string" ? data.stats : "",
          notes: Array.isArray(data.notes) ? data.notes.filter((n): n is string => typeof n === "string") : [],
        });
      } else if (data.type === "sapiom-canvas:graph") {
        setGraph(parseCanvasGraph((data as { graph?: unknown }).graph));
      } else if (data.type === "sapiom-canvas:node") {
        // A board pick: populate the bottom inspector, stay on the Canvas
        // tab. The Steps tab is the inspector's explicit "Open in Steps"
        // drill now, never a side effect of a click on the board.
        const id = (data as { id?: unknown }).id;
        if (typeof id === "string") setSelectedNodeId(id);
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
    setDetailStepId(null);
    setSelectedNodeId(null);
    setExpandedStepId(null);
    setOverviewOpen(true);
    setHoveredNode(false);
    hoveredNodeRef.current = false;
    // The old document's fit inputs and any manual view are meaningless for
    // the incoming one — start at rest and let its size message refit.
    setGraphSize(null);
    setRestView({ zoom: 1, x: 0, y: 0 });
    userAdjustedRef.current = false;
  }, [sessionId, reloadKey]);
  const detailNode = graph && detailStepId ? (graph.nodes.find((n) => n.id === detailStepId) ?? null) : null;
  // The slide-out must not empty mid-flight: keep the LAST drilled step
  // rendered in the off-going pane so back reads as the detail sliding away,
  // not vanishing. Cleared with the graph (document swap).
  const lastDetailRef = useRef<typeof detailNode>(null);
  if (detailNode) lastDetailRef.current = detailNode;
  if (!graph) lastDetailRef.current = null;
  const renderedDetail = detailNode ?? lastDetailRef.current;
  // The board-picked node the bottom inspector shows — validated against the
  // live graph so a stale id (document re-render dropped the step) renders
  // the overview, never a ghost step.
  const selectedNode =
    graph && selectedNodeId ? (graph.nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
  // Keep the board's is-selected ring in sync with whichever selection is
  // showing: the Steps tab's full-pane drill wins while open; otherwise the
  // inspector's board pick. Both null clears the ring.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "sapiom-canvas:select", id: detailStepId ?? selectedNodeId },
      "*",
    );
  }, [detailStepId, selectedNodeId]);
  const overview =
    postedOverview ??
    (isMockMode() && boundWorkflow ? MOCK_CANVAS_OVERVIEWS[boundWorkflow.path] : undefined);
  // Failed-task panels the user has explicitly dismissed (client-side only —
  // the task record itself stays in the server's list).
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(new Set());

  // Passed through to the served canvas so a kit-based template can match the
  // app's current theme instead of always rendering dark. Legacy canvases
  // that don't read the param are unaffected.
  useEffect(() => subscribeTheme(setTheme), []);

  // Probe once per session for pre-existing content — the agent may have written
  // it in an earlier turn, before this pane was around to catch a reload event.
  useEffect(() => {
    setFrameLoading(true);
    if (!sessionId) {
      setHasGeneratedContent(false);
      return;
    }
    // Mock mode ships no live probe. A mock session that ships a bundled canvas
    // doc (public/canvas/<id>/, i.e. hasMockCanvasDoc) renders its board on
    // FIRST PAINT — the demo opens on its seeded agent's live board, not an
    // empty pane. Sessions without a bundled doc stay honestly empty and never
    // mount an iframe (the invariant smoke.spec guards); no fabricated docs.
    if (isMockMode()) {
      setHasGeneratedContent(hasMockCanvasDoc(sessionId));
      return;
    }
    setHasGeneratedContent(false);
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
    if (lastMessage.type === "canvas.reload" && lastMessage.harnessSessionId === sessionId) {
      // Mock mode ships REAL documents only for MOCK_CANVAS_SESSIONS (files
      // under public/canvas/<id>/). For any other mock session the iframe
      // URL would be the static host's 404 page — never mount it; the pane
      // keeps its honest empty state instead.
      if (isMockMode() && !hasMockCanvasDoc(sessionId)) return;
      setHasGeneratedContent(true);
      setFrameLoading(true);
      setReloadKey((key) => key + 1);
    }
  }, [lastMessage, sessionId]);

  // The server resolves the canvas root by the session's CURRENT binding, so
  // a bind/unbind changes what the same URL serves — refetch immediately
  // instead of waiting for the render write's canvas.reload to arrive. A new
  // document also invalidates the old view transform.
  const boundWorkflowPath = boundWorkflow?.path ?? null;
  useEffect(() => {
    setFrameLoading(true);
    setReloadKey((key) => key + 1);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRestView({ zoom: 1, x: 0, y: 0 });
    userAdjustedRef.current = false;
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
  const runningTask = sessionTasks.find((task) => task.status === "running") ?? null;
  const latestFinished = sessionTasks
    .filter((task) => task.status !== "running")
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  const failedTask =
    !runningTask && latestFinished?.status === "failed" && !dismissedTaskIds.has(latestFinished.id)
      ? latestFinished
      : null;
  const retryMacro = failedTask ? (macros.find((macro) => macro.id === failedTask.macroId) ?? null) : null;

  // The header's action IS Visualize now — one click re-fires the same macro
  // that generated what's already on screen. The reload starts eagerly (fresh
  // iframe fetch + skeleton + spinning icon on THIS click), and the macro's
  // own canvas.reload event swaps in the re-rendered document when it lands.
  const handleReVisualize = (): void => {
    if (!visualizeMacro) return;
    if (hasGeneratedContent) {
      // Guarantee the refresh is SEEN: the skeleton (and the spinning icon
      // that tracks it) holds for at least ~900ms even if the document
      // round-trips instantly.
      skeletonHoldUntilRef.current = Date.now() + 900;
      setFrameLoading(true);
      setReloadKey((key) => key + 1);
    }
    onRunMacro(visualizeMacro);
    track("visualize.triggered");
  };

  // Content is on screen and loadable — the only state where panel-level
  // view actions (expand) make sense.
  // Mock hard gate, derived (not state): only sessions with a bundled demo
  // document may EVER mount the iframe — state can go stale for one render
  // across a session switch, and on the static Pages build a wrong URL is
  // GitHub's 404 page rendered inside the pane.
  const sessionHasServableDoc = sessionId != null && (!isMockMode() || hasMockCanvasDoc(sessionId));
  const showsContent = hasGeneratedContent && sessionHasServableDoc;
  const showingFrame = Boolean(sessionId) && !failedTask && showsContent && !probing;

  return (
    <aside className="canvas-pane">
      {boundWorkflow && !overviewActive && (
        <WorkflowActionsHeader
          workflow={boundWorkflow}
          onReVisualize={handleReVisualize}
          reVisualizeDisabledReason={visualizeDisabledReason}
          refreshing={Boolean(runningTask) || (showingFrame && frameLoading)}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((v) => !v)}
          canExpand={showingFrame}
          detailStep={detailNode}
          onBack={() => setDetailStepId(null)}
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
      {noSessionAgent ? (
        /* An agent opened with no live session in its workspace: honest
           absence, naming the agent. The main panel carries the primary
           "Start session" action, so this state teaches the move without a
           duplicate button. */
        <EmptyState
          className="canvas-empty"
          testId="canvas-empty-no-session"
          icon="Radio"
          title={`No running session for ${noSessionAgent}`}
          body={
            surface === "steps"
              ? "Start a session to map this agent's steps here."
              : "Start a session to map, run, and inspect this agent."
          }
        />
      ) : overviewActive || !sessionId ? (
        // Overview mode reads identically to fresh install: no
        // session is on display, so no Visualize CTA and no stale copy.
        surface === "steps" ? (
          <EmptyState
            className="canvas-empty"
            icon="Radio"
            title="No session"
            body="Start a session to see its workflow steps here."
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
      ) : !showsContent && surface === "steps" && run ? (
        /* Nothing visualized yet, but a run was observed: the live
           per-step data renders instead of "No steps yet". */
        <div className="canvas-steps-surface" data-testid="canvas-steps-surface">
          <RunStepsList run={run} target={runTarget} />
        </div>
      ) : !showsContent && sessionExited ? (
        /* nothing was generated and the session is dead — inviting a
           Visualize here would target a pty that no longer exists. */
        <EmptyState
          className="canvas-empty"
          testId="canvas-empty-exited"
          icon="History"
          title="Session ended"
          body={`Resume the session to visualize its ${surface === "steps" ? "workflow steps" : "workflow"} here.`}
        />
      ) : !showsContent ? (
        /* Header claim, one supporting line, then the action — top to bottom.
           The Visualize CTA works from either tab: it renders the board AND
           posts the step graph the Steps tab projects. */
        <EmptyState
          className="canvas-empty"
          icon="Sparkles"
          title={surface === "steps" ? "No steps yet" : "Nothing generated yet"}
          body={
            surface === "steps"
              ? "Steps are read from the visualized workflow. Visualize on the Canvas tab to map them."
              : "Visualize the bound workflow; the canvas updates as the agent works."
          }
          cta={
            visualizeMacro && (
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
            )
          }
        />
      ) : (
        <div
          className={"canvas-frame-wrap" + (expanded ? " is-expanded" : "")}
          data-view={surface === "board" ? "board" : detailNode ? "detail" : "steps"}
        >
          {/* Full-pane slide: pane A is the active surface (board on the
              Canvas tab, the steps list on the Steps tab), pane B the
              drilled step. The subheader above swaps chrome per view
              (WorkflowActionsHeader). The board stays MOUNTED under the
              steps surface: the iframe is the graph's source of truth. */}
          <div className="canvas-slide-track">
          <div className="canvas-slide-pane">
          <div className={"canvas-visual" + (surface === "steps" ? " is-offstage" : "")}>
          <div className="canvas-view-controls" data-testid="canvas-view-controls">
            <button
              className="theme-toggle"
              data-testid="canvas-zoom-out"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={zoom <= 0.5}
              onClick={() => {
                userAdjustedRef.current = true;
                setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100));
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
              onClick={() => setExpanded(false)}
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
                  if (reason.length < 4) return "The workflow graph could not be extracted. Open the terminal for details.";
                  return reason.includes(": ") ? reason.slice(reason.indexOf(": ") + 2).split(". ")[0] : reason;
                })()}
              </p>
              <div className="canvas-error-actions">
                <button
                  className="btn-primary"
                  data-testid="canvas-error-fix"
                  onClick={() =>
                    onInjectPrompt(
                      `The canvas render for ${postedError.title || "this workflow"} failed: ${postedError.reason} Fix the project so the workflow graph extracts cleanly.`,
                    )
                  }
                >
                  Ask agent to fix
                </button>
                <button
                  className="btn-ghost"
                  data-testid="canvas-error-retry"
                  onClick={() => {
                    skeletonHoldUntilRef.current = Date.now() + 900;
                    setFrameLoading(true);
                    setReloadKey((key) => key + 1);
                  }}
                >
                  Retry
                </button>
              </div>
              <details className="canvas-error-details">
                <summary>Details</summary>
                <pre>{postedError.reason.trim().length >= 4 ? postedError.reason : "The rendered document reported a failure without details. Re-run Visualize or check the terminal."}</pre>
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
              aria-label="Show workflow overview"
              data-tooltip="Show workflow overview"
              onClick={() => setOverviewOpen(true)}
            >
              i
            </button>
          )}
          <iframe
            ref={frameRef}
            key={`${sessionId}:${reloadKey}`}
            className="canvas-iframe"
            src={`${import.meta.env.BASE_URL}canvas/${sessionId}/${isMockMode() ? "index.html" : ""}?theme=${theme}`}
            sandbox="allow-scripts"
            onLoad={() => {
              handleFrameLoaded();
              // A fresh document starts at identity; re-sync the current view.
              frameRef.current?.contentWindow?.postMessage(
                { type: "sapiom-canvas:view", zoom, x: pan.x, y: pan.y },
                "*",
              );
            }}
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
              {graph && graph.nodes.length > 0 ? (
                <CanvasStepsList
                  graph={graph}
                  run={run}
                  runTarget={runTarget}
                  workflows={workflows}
                  onOpenWorkflow={onOpenWorkflow}
                  expandedId={expandedStepId}
                  onToggle={(id) => setExpandedStepId((cur) => (cur === id ? null : id))}
                  onOpenDetail={setDetailStepId}
                />
              ) : run ? (
                /* No structural graph, but a real run was observed:
                   its per-step truth renders instead of a dead end. */
                <RunStepsList run={run} target={runTarget} />
              ) : (
                /* Same title as the pre-render empty state; the hint names
                   this cause (a rendered canvas that posted no graph). */
                <EmptyState
                  className="canvas-empty"
                  icon="Sparkles"
                  title="No steps yet"
                  body="This canvas has not posted a step graph. Re-run Visualize on the Canvas tab to map them."
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
              onSelectStep={setSelectedNodeId}
              onOpenSteps={() => {
                if (selectedNodeId) setDetailStepId(selectedNodeId);
                onOpenSteps();
              }}
              onDeselect={() => setSelectedNodeId(null)}
              onCollapse={() => setOverviewOpen(false)}
              onInjectPrompt={onInjectPrompt}
            />
          )}
          </div>
          <div className="canvas-slide-pane" aria-hidden={detailNode ? undefined : true}>
            {renderedDetail && graph && (
              <CanvasStepDetail
                graph={graph}
                node={renderedDetail}
                run={run}
                onSelectStep={setDetailStepId}
                workflows={workflows}
                onOpenWorkflow={onOpenWorkflow}
              />
            )}
          </div>
          </div>
        </div>
      )}
    </aside>
  );
}
