import type { AgentMapInitializationStatus } from "@sapiom/agent-map/agent-map-initialization";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import type {
  AgentMapImplementationsResponse,
  AgentMapWorkspaceResponse,
  PlanNodeId,
} from "@sapiom/agent-map";
import type { WorkflowInfo } from "@shared/types";
import type { HarnessApi } from "../lib/api";
import type { GraphViewportStore } from "../lib/graph-viewport";
import {
  agentMapDeployments,
  type AgentMapDeployments,
} from "../lib/agent-map-deployment";
import { DEPLOYMENT_UNAVAILABLE } from "../lib/workflow-deployment";
import {
  agentMapNavigationError,
  agentMapTargetWorkflow,
  type AgentMapNodeTarget,
} from "../lib/agent-map-navigation";

import type { AgentMapWorkspacePaneState } from "../lib/use-agent-map-entry";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { AgentMapCanvas } from "./AgentMapCanvas";
import { Icon } from "./Icon";

/** A picked map node that is not an agent: a resource, a step or a group. It
 *  opens no agent, only the card's header row (flow 4.2.3). */
export interface MapNodePick {
  id: PlanNodeId;
  name: string;
  kind: string;
}

interface AgentMapPaneProps {
  viewportStore: GraphViewportStore;
  visible: boolean;
  api: Pick<
    HarnessApi,
    "getAgentMapNodeImplementation" | "getAgentMapImplementations"
  >;
  workflows: readonly WorkflowInfo[];
  refreshWorkflows: () => Promise<WorkflowInfo[]>;
  /**
   * Single click on an agent node: the card names it (flow-map-chat-overlay.md
   * 4.2). The map resolves the node to its registry agent first.
   */
  onPickAgent: (workflow: WorkflowInfo, target: AgentMapNodeTarget) => void;
  /** Double click on an agent node: its modal over this map (4.2.4). */
  onEnterAgent: (workflow: WorkflowInfo, target: AgentMapNodeTarget) => void;
  /** Whether the shell holds an agent pick; false releases the node's ring. */
  agentPicked: boolean;
  /** The picked node that is not an agent, held by the project view so the
   *  card can name it and Escape can clear it. */
  nodePick: MapNodePick | null;
  onNodePick: (node: MapNodePick | null) => void;
  /** A click on the empty map: the card returns to the project (4.2.5). */
  onClearPick: () => void;
  /** The floating card, over the board's bottom-right. It is out of flow, so
   *  nothing it shows changes the board's width (I1). */
  card: JSX.Element | null;
  state: AgentMapWorkspacePaneState;
  initialization?: AgentMapInitializationStatus | null;
  onRetryGeneration?: () => void;
  unavailable: string | null;
  onRetry: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}

export function AgentMapPane({
  viewportStore,
  visible,
  api,
  workflows,
  refreshWorkflows,
  onPickAgent,
  onEnterAgent,
  agentPicked,
  nodePick,
  onNodePick,
  onClearPick,
  card,
  state,
  initialization,
  onRetryGeneration,
  unavailable,
  onRetry,
  expanded,
  onToggleExpanded,
}: AgentMapPaneProps): JSX.Element {
  const value = state.status === "ready" ? state.value : null;
  const proposal = value?.proposal ?? null;
  // A picked node that is not an agent (a resource, a step, or an agent whose
  // folder could not be found): highlighted, announced, and named by the
  // card's header row. No inspector beside the map (flow §5).
  const selected = nodePick?.id ?? null;
  const setSelected = useCallback(
    (nodeId: PlanNodeId | null): void => {
      const node = nodeId
        ? proposal?.nodes.find((candidate) => candidate.id === nodeId)
        : undefined;
      onNodePick(node ? { id: node.id, name: node.name, kind: node.kind } : null);
    },
    [onNodePick, proposal],
  );
  // The agent node the card is about. Held apart from `selected`: a
  // selection releases it, so the card names only the latest pick.
  const [picked, setPicked] = useState<PlanNodeId | null>(null);
  useEffect(() => {
    if (!agentPicked) setPicked(null);
  }, [agentPicked]);
  const [pending, setPending] = useState<PlanNodeId | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);
  const current = useRef({ value, workflows, visible });
  current.current = { value, workflows, visible };

  // Deployment refreshes must not cancel an in-flight node navigation.
  const bindingGeneration = useRef(0);
  const [retryStatus, setRetryStatus] = useState(0);
  const [bindingState, setBindingState] = useState<{
    value: AgentMapWorkspaceResponse | null;
    response: AgentMapImplementationsResponse | null;
    phase: "loading" | "available" | "unavailable";
  }>({ value: null, response: null, phase: "loading" });
  const previousDeployments = useRef<AgentMapDeployments>(new Map());
  const projectId = value?.project.projectId;
  // Discovery/moves can change binding resolution; cloud status alone cannot.
  const inventoryKey = JSON.stringify(
    workflows.flatMap((workflow) =>
      (workflow.studioBindings ?? [])
        .filter((binding) => binding.projectId === projectId)
        .map((binding) => JSON.stringify([binding.agentId, workflow.path])),
    ).sort(),
  );
  useEffect(() => {
    if (visible && projectId) void refreshWorkflows().catch(() => undefined);
  }, [visible, projectId, refreshWorkflows, retryStatus]);
  useEffect(() => {
    const request = ++bindingGeneration.current;
    if (
      !visible ||
      !value?.proposal?.nodes.some(
        (node) => node.kind === "agent" || node.kind === "subagent",
      )
    )
      return;
    setBindingState((old) => ({
      value,
      response: old.response,
      phase: "loading",
    }));
    void api.getAgentMapImplementations(value.project.projectId).then(
      (response) => {
        if (request === bindingGeneration.current)
          setBindingState({ value, response, phase: "available" });
      },
      () => {
        if (request === bindingGeneration.current)
          setBindingState((old) => ({
            value,
            response: old.response,
            phase: "unavailable",
          }));
      },
    );
    return () => {
      bindingGeneration.current += 1;
    };
  }, [api, visible, value, inventoryKey, retryStatus]);
  const deployments = useMemo(
    () =>
      value
        ? agentMapDeployments(
            value,
            bindingState.response,
            workflows,
            previousDeployments.current,
            bindingState.value === value ? bindingState.phase : "loading",
          )
        : new Map(),
    [value, bindingState, workflows],
  );
  useEffect(() => {
    previousDeployments.current = deployments;
  }, [deployments]);

  useEffect(() => {
    generation.current += 1;
    setPending(null);
    setOpenError(null);
    return () => {
      generation.current += 1;
    };
  }, [value, visible]);

  const selectNode = (nodeId: PlanNodeId, control: HTMLButtonElement): void => {
    generation.current += 1;
    returnFocus.current = control;
    setPending(null);
    setOpenError(null);
    setSelected(nodeId);
    // The new pick replaces the agent's: clearing it later must not bring
    // back a panel for a node the user has since moved off.
    setPicked(null);
  };

  /** Resolve an agent node to its registry agent, then hand it to `open`. */
  const resolveAgent = async (
    nodeId: PlanNodeId,
    control: HTMLButtonElement,
    open: (workflow: WorkflowInfo, target: AgentMapNodeTarget) => void,
  ): Promise<void> => {
    const node = proposal?.nodes.find((candidate) => candidate.id === nodeId);
    if (!visible || !value || !node) return;
    if (node.kind !== "agent" && node.kind !== "subagent")
      return selectNode(nodeId, control);
    const request = ++generation.current;
    const isCurrent = () =>
      generation.current === request &&
      current.current.value === value &&
      current.current.visible;
    returnFocus.current = control;
    setSelected(null);
    setPicked(null);
    setOpenError(null);
    setPending(nodeId);
    try {
      const target = await api.getAgentMapNodeImplementation(
        value.project.projectId,
        nodeId,
      );
      if (!isCurrent()) return;
      let workflow = agentMapTargetWorkflow(target, current.current.workflows);
      if (!workflow) {
        const refreshed = await refreshWorkflows();
        if (!isCurrent()) return;
        workflow = agentMapTargetWorkflow(target, refreshed);
      }
      if (!workflow)
        throw Object.assign(new Error(), { code: "target_not_found" });
      generation.current += 1;
      setPending(null);
      setPicked(nodeId);
      open(workflow, target);
    } catch (error) {
      if (!isCurrent()) return;
      setPending(null);
      setOpenError(agentMapNavigationError(error));
      setSelected(nodeId);
    }
  };

  useEffect(() => {
    if (
      selected &&
      (!proposal || !proposal.nodes.some((node) => node.id === selected))
    ) {
      setSelected(null);
    }
  }, [proposal, selected, setSelected]);

  const clearSelection = useCallback((): void => {
    generation.current += 1;
    setSelected(null);
    setPending(null);
    setOpenError(null);
    returnFocus.current?.focus();
  }, [setSelected]);

  // Match the per-agent graph's full-view contract: Escape unwinds one layer
  // at a time, clearing the selection before it lowers the map overlay.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (selected !== null) clearSelection();
      else if (expanded) onToggleExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection, expanded, onToggleExpanded, selected]);

  let content: JSX.Element;
  if (state.status === "error" && unavailable) {
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
          state.canRetry !== false ? (
            <button
              type="button"
              className="btn-secondary"
              data-testid="agent-map-retry"
              onClick={onRetry}
            >
              Reload map
            </button>
          ) : undefined
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
  } else if (proposal && proposal.nodes.length > 0) {
    content = (
      <PopulatedAgentMap
        viewportStore={viewportStore}
        value={value}
        selected={selected}
        deployments={deployments}
        onRetryStatus={() => setRetryStatus((revision) => revision + 1)}
        onSelectNode={(nodeId, control) =>
          void resolveAgent(nodeId, control, onPickAgent)
        }
        onEnterNode={(nodeId, control) =>
          void resolveAgent(nodeId, control, onEnterAgent)
        }
        picked={agentPicked ? picked : null}
        card={card}
        pending={pending}
        openError={openError}
        onClearSelection={clearSelection}
        onClearPick={() => {
          clearSelection();
          onClearPick();
        }}
      />
    );
  } else if (
    !proposal &&
    (initialization?.status === "queued" ||
      initialization?.status === "running")
  ) {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-generating"
        icon="Workflow"
        title="Generating Agent Map…"
      />
    );
  } else if (!proposal && initialization?.status === "failed") {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-generation-error"
        icon="TriangleAlert"
        title="Agent Map couldn't be generated"
        cta={
          initialization.retryable ? (
            <button
              type="button"
              className="btn-secondary"
              data-testid="agent-map-generation-retry"
              onClick={onRetryGeneration}
            >
              Retry generation
            </button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-empty"
        icon="Workflow"
        title="Nothing generated yet"
      />
    );
  }

  return (
    <div
      className={`canvas-frame-wrap${expanded ? " is-expanded" : ""}`}
      data-testid="agent-map-frame"
    >
      {content}
      {expanded && (
        <button
          type="button"
          className="macro-icon-btn canvas-expand-exit"
          data-testid="canvas-expand-exit"
          aria-label="Exit expanded Agent Map"
          title="Exit expanded Agent Map (Esc)"
          onClick={onToggleExpanded}
        >
          <Icon name="Minimize2" size={14} />
        </button>
      )}
    </div>
  );
}

function PopulatedAgentMap({
  viewportStore,
  value,
  deployments,
  onRetryStatus,
  selected,
  onSelectNode,
  onEnterNode,
  picked,
  card,
  pending,
  openError,
  onClearSelection,
  onClearPick,
}: {
  viewportStore: GraphViewportStore;
  value: AgentMapWorkspaceResponse;
  deployments: AgentMapDeployments;
  onRetryStatus: () => void;
  selected: PlanNodeId | null;
  onSelectNode: (nodeId: PlanNodeId, control: HTMLButtonElement) => void;
  onEnterNode: (nodeId: PlanNodeId, control: HTMLButtonElement) => void;
  picked: PlanNodeId | null;
  card: JSX.Element | null;
  pending: PlanNodeId | null;
  openError: string | null;
  onClearSelection: () => void;
  onClearPick: () => void;
}): JSX.Element {
  // A click on the empty board clears the pick, a drag pans it: only a press
  // that did not move counts as a click (4.2.5).
  const press = useRef<{ x: number; y: number } | null>(null);
  const proposal = value.proposal!;
  const failed = [...deployments.values()].filter(
    (status) => status.unavailable && !status.loading,
  );
  return (
    <div
      className="agent-map-live"
      data-testid="agent-map-live"
      data-project-id={value.project.projectId}
      {...trackingAttrs({ surface: "agent_map" })}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !selected) return;
        event.preventDefault();
        event.stopPropagation();
        onClearSelection();
      }}
    >
      <div className="agent-map-live-header">
        <span className="agent-map-node-meta">
          Version {proposal.version}
        </span>
        {failed.length > 0 && (
          <div
            className="agent-map-deployment-message"
            role="status"
            data-testid="agent-map-deployment-error"
          >
            {failed.some((status) => status.indicator === null) && (
              <span>{DEPLOYMENT_UNAVAILABLE}</span>
            )}
            <button
              type="button"
              className="status-tag status-tag-action"
              onClick={onRetryStatus}
            >
              Retry status
            </button>
          </div>
        )}
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
          if (selected || picked) onClearPick();
        }}
      >
        <AgentMapCanvas
          viewportStore={viewportStore}
          proposal={proposal}
          deployments={deployments}
          selectedNodeId={selected ?? picked}
          onSelectNode={onSelectNode}
          onEnterNode={onEnterNode}
          pendingNodeId={pending}
        />
        {card}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {pending
          ? "Opening agent…"
          : selected
            ? `Selected ${proposal.nodes.find((node) => node.id === selected)?.name ?? "node"}`
            : ""}
      </p>
    </div>
  );
}
