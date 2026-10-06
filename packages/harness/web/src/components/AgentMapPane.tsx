import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { WorkflowInfo } from "@shared/types";
import type { GraphViewportStore } from "../lib/graph-viewport";
import {
  agentFolder,
  workflowForAgent,
  type MapAgent,
  type ProjectMapResponse,
} from "../lib/project-map";
import type { ProjectMapEntry } from "../lib/use-project-map";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { AgentMapCanvas } from "./AgentMapCanvas";

/** A picked map agent that Studio cannot open: its folder is not in the
 *  agent list. The card names it and offers no verbs (flow 4.2.3). */
export interface MapNodePick {
  id: string;
  name: string;
  kind: string;
}

interface AgentMapPaneProps {
  viewportStore: GraphViewportStore;
  workflows: readonly WorkflowInfo[];
  refreshWorkflows: () => Promise<WorkflowInfo[]>;
  /** Add an agent folder to Studio's agent list (its registry only; nothing
   *  is written to the folder). A map agent the list does not hold yet, such
   *  as a `defineAgent` folder with no `sapiom.json`, is added on first open. */
  connectAgent: (path: string) => Promise<WorkflowInfo>;
  /** Single click on an agent: the card names it (flow-map-chat-overlay.md 4.2). */
  onPickAgent: (workflow: WorkflowInfo) => void;
  /** Double click on an agent: its modal over this map (4.2.4). */
  onEnterAgent: (workflow: WorkflowInfo) => void;
  /** The agent the shell holds as picked, by folder; it rings its node. */
  pickedPath: string | null;
  /** The picked agent Studio cannot open, held by the project view so the
   *  card can name it and Escape can clear it. */
  nodePick: MapNodePick | null;
  onNodePick: (node: MapNodePick | null) => void;
  /** A click on the empty map: the card returns to the project (4.2.5). */
  onClearPick: () => void;
  /** The card's map chat is open: Escape closes it first (4.3.3), so the
   *  map does not take Escape to clear its pick. */
  chatOpen?: boolean;
  /** The floating card, over the board's bottom-right. It is out of flow, so
   *  nothing it shows changes the board's width (I1). */
  card: JSX.Element | null;
  entry: ProjectMapEntry;
}

export function AgentMapPane({
  viewportStore,
  workflows,
  refreshWorkflows,
  connectAgent,
  onPickAgent,
  onEnterAgent,
  pickedPath,
  nodePick,
  onNodePick,
  onClearPick,
  chatOpen = false,
  card,
  entry,
}: AgentMapPaneProps): JSX.Element {
  const { state } = entry;
  const value = state.status === "ready" ? state.value : null;
  const [openError, setOpenError] = useState<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);
  const current = useRef({ value, workflows });
  current.current = { value, workflows };

  // A pick that no longer names an agent on the map (it was removed, or the
  // ref changed) is released.
  useEffect(() => {
    if (nodePick && value && !value.map.agents.some((agent) => agent.slug === nodePick.id))
      onNodePick(null);
  }, [nodePick, onNodePick, value]);

  /** Match a map agent to its registry row by folder, then hand it to `open`. */
  const resolveAgent = async (
    slug: string,
    control: HTMLButtonElement,
    open: (workflow: WorkflowInfo) => void,
  ): Promise<void> => {
    const snapshot = current.current.value;
    const agent = snapshot?.map.agents.find((candidate) => candidate.slug === slug);
    if (!snapshot || !agent) return;
    const request = ++generation.current;
    returnFocus.current = control;
    setOpenError(null);
    let workflow = workflowForAgent(snapshot.map, agent, current.current.workflows);
    if (!workflow) {
      // A folder made since the last scan: one refresh finds it.
      const refreshed = await refreshWorkflows().catch(() => [] as WorkflowInfo[]);
      if (generation.current !== request) return;
      workflow = workflowForAgent(snapshot.map, agent, refreshed);
    }
    const folder = agentFolder(snapshot.map, agent);
    // At a git ref the folder is the ref's, not necessarily the working copy's:
    // never add it to the agent list from there.
    if (!workflow && folder && !snapshot.map.ref) {
      workflow = await connectAgent(folder).catch(() => null);
      if (generation.current !== request) return;
    }
    if (workflow) {
      onNodePick(null);
      open(workflow);
      return;
    }
    onNodePick({ id: agent.slug, name: agent.slug, kind: "agent" });
    setOpenError(`Studio couldn't open ${agent.slug} as an agent.`);
  };

  const pickedSlug = (snapshot: ProjectMapResponse): string | null => {
    if (nodePick) return nodePick.id;
    if (!pickedPath) return null;
    const match = snapshot.map.agents.find(
      (agent) => workflowForAgent(snapshot.map, agent, [{ path: pickedPath }]) !== null,
    );
    return match?.slug ?? null;
  };

  const clearSelection = useCallback((): void => {
    generation.current += 1;
    setOpenError(null);
    onNodePick(null);
    returnFocus.current?.focus();
  }, [onNodePick]);

  let content: JSX.Element;
  if (state.status === "error" && state.unavailable) {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-project-unavailable"
        icon="Folder"
        title="Project unavailable"
        body="This project was removed or is unavailable to your current account. Select another project to continue."
      />
    );
  } else if (state.status === "error") {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-load-error"
        icon="TriangleAlert"
        title="Agent Map couldn't load"
        body={state.message}
        cta={
          <button
            type="button"
            className="btn-secondary"
            data-testid="agent-map-retry"
            onClick={entry.refresh}
          >
            Reload map
          </button>
        }
      />
    );
  } else if (value === null) {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-loading"
        icon="Workflow"
        title="Loading Agent Map…"
      />
    );
  } else {
    content = (
      <PopulatedAgentMap
        viewportStore={viewportStore}
        value={value}
        entry={entry}
        selected={pickedSlug(value)}
        hasPick={nodePick != null || pickedPath != null}
        onSelectNode={(slug, control) => void resolveAgent(slug, control, onPickAgent)}
        onEnterNode={(slug, control) => void resolveAgent(slug, control, onEnterAgent)}
        card={card}
        openError={openError}
        onClearSelection={clearSelection}
        chatOpen={chatOpen}
        onClearPick={() => {
          clearSelection();
          onClearPick();
        }}
      />
    );
  }

  return (
    <div className="canvas-frame-wrap" data-testid="agent-map-frame">
      {content}
    </div>
  );
}

function PopulatedAgentMap({
  viewportStore,
  value,
  entry,
  selected,
  hasPick,
  onSelectNode,
  onEnterNode,
  card,
  openError,
  onClearSelection,
  onClearPick,
  chatOpen,
}: {
  viewportStore: GraphViewportStore;
  value: ProjectMapResponse;
  entry: ProjectMapEntry;
  selected: string | null;
  hasPick: boolean;
  onSelectNode: (slug: string, control: HTMLButtonElement) => void;
  onEnterNode: (slug: string, control: HTMLButtonElement) => void;
  card: JSX.Element | null;
  openError: string | null;
  onClearSelection: () => void;
  onClearPick: () => void;
  chatOpen: boolean;
}): JSX.Element {
  // A click on the empty board clears the pick, a drag pans it: only a press
  // that did not move counts as a click (4.2.5).
  const press = useRef<{ x: number; y: number } | null>(null);
  const selectedAgent: MapAgent | undefined = selected
    ? value.map.agents.find((agent) => agent.slug === selected)
    : undefined;
  return (
    <div
      className="agent-map-live"
      data-testid="agent-map-live"
      data-project-id={value.projectId}
      data-ref={entry.mapRef ?? undefined}
      {...trackingAttrs({ surface: "agent_map" })}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !selected || chatOpen) return;
        event.preventDefault();
        event.stopPropagation();
        onClearSelection();
      }}
    >
      <div className="agent-map-live-header">
        <span className="agent-map-project-name" data-testid="agent-map-project-name">
          {value.displayName}
        </span>
        {/* Why a picked agent could not be opened. The header row, not a
            panel beside the board, so the board's width never changes. */}
        {openError && (
          <span
            className="agent-map-deployment-message"
            role="alert"
            data-testid="agent-map-open-error"
          >
            {openError}
          </span>
        )}
        <span className="agent-map-node-meta agent-map-count" data-testid="agent-map-count">
          {value.map.agents.length === 1 ? "1 agent" : `${value.map.agents.length} agents`}
        </span>
      </div>
      <div
        className="agent-map-live-body"
        onPointerDownCapture={(event) => {
          press.current = { x: event.clientX, y: event.clientY };
        }}
        onClick={(event) => {
          const start = press.current;
          press.current = null;
          const target = event.target as Element;
          if (
            !start ||
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 ||
            !target.closest(".agent-map-viewport") ||
            target.closest("button")
          )
            return;
          if (hasPick) onClearPick();
        }}
      >
        {value.map.agents.length > 0 ? (
          <AgentMapCanvas
            viewportStore={viewportStore}
            projectId={value.projectId}
            map={value.map}
            selectedSlug={selected}
            onSelectNode={onSelectNode}
            onEnterNode={onEnterNode}
          />
        ) : (
          <EmptyState
            className="canvas-empty"
            testId="agent-map-empty"
            icon="Workflow"
            title={entry.mapRef ? `No agents at ${entry.mapRef}` : "No agents in this project"}
          />
        )}
        {card}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {selectedAgent ? `Selected ${selectedAgent.slug}` : ""}
      </p>
    </div>
  );
}
