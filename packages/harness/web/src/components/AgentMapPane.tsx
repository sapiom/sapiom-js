import type { AgentMapInitializationStatus } from "@shared/agent-map-initialization";
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
} from "@shared/agent-map";
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
import { AgentMapInspector } from "./AgentMapInspector";
import { Icon } from "./Icon";

interface AgentMapPaneProps {
  viewportStore: GraphViewportStore;
  visible: boolean;
  api: Pick<
    HarnessApi,
    "getAgentMapNodeImplementation" | "getAgentMapImplementations"
  >;
  workflows: readonly WorkflowInfo[];
  refreshWorkflows: () => Promise<WorkflowInfo[]>;
  onOpenAgent: (workflow: WorkflowInfo, target: AgentMapNodeTarget) => void;
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
  onOpenAgent,
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
  const [selected, setSelected] = useState<PlanNodeId | null>(null);
  const [pending, setPending] = useState<PlanNodeId | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);
  const current = useRef({ value, workflows, onOpenAgent, visible });
  current.current = { value, workflows, onOpenAgent, visible };

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

  const inspect = (nodeId: PlanNodeId, control: HTMLButtonElement): void => {
    generation.current += 1;
    returnFocus.current = control;
    setPending(null);
    setOpenError(null);
    setSelected(nodeId);
  };

  const activate = async (
    nodeId: PlanNodeId,
    control: HTMLButtonElement,
  ): Promise<void> => {
    const node = proposal?.nodes.find((candidate) => candidate.id === nodeId);
    if (!visible || !value || !node) return;
    if (node.kind !== "agent" && node.kind !== "subagent")
      return inspect(nodeId, control);
    const request = ++generation.current;
    const isCurrent = () =>
      generation.current === request &&
      current.current.value === value &&
      current.current.visible;
    returnFocus.current = control;
    setSelected(null);
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
      current.current.onOpenAgent(workflow, target);
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
  }, [proposal, selected]);

  const closeInspector = useCallback((): void => {
    generation.current += 1;
    setSelected(null);
    setPending(null);
    setOpenError(null);
    returnFocus.current?.focus();
  }, []);

  // Match the per-agent graph's full-view contract: Escape unwinds one layer
  // at a time, closing node detail before it lowers the map overlay.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (selected !== null) closeInspector();
      else if (expanded) onToggleExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeInspector, expanded, onToggleExpanded, selected]);

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
        onSelectNode={activate}
        onInspectNode={inspect}
        pending={pending}
        openError={openError}
        onCloseInspector={closeInspector}
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
  onInspectNode,
  pending,
  openError,
  onCloseInspector,
}: {
  viewportStore: GraphViewportStore;
  value: AgentMapWorkspaceResponse;
  deployments: AgentMapDeployments;
  onRetryStatus: () => void;
  selected: PlanNodeId | null;
  onSelectNode: (nodeId: PlanNodeId, control: HTMLButtonElement) => void;
  onInspectNode: (nodeId: PlanNodeId, control: HTMLButtonElement) => void;
  pending: PlanNodeId | null;
  openError: string | null;
  onCloseInspector: () => void;
}): JSX.Element {
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
        onCloseInspector();
      }}
    >
      <div className="agent-map-live-header">
        <span className="system-graph-node-meta">
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
      </div>
      <div className="agent-map-live-body">
        <AgentMapCanvas
          viewportStore={viewportStore}
          proposal={proposal}
          deployments={deployments}
          selectedNodeId={selected}
          onSelectNode={onSelectNode}
          onInspectNode={onInspectNode}
          pendingNodeId={pending}
        />
        {selected && (
          <AgentMapInspector
            snapshot={value}
            nodeId={selected}
            deployment={deployments.get(selected)}
            onClose={onCloseInspector}
            openError={openError}
          />
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {pending
          ? "Opening agent…"
          : selected
            ? `Selected ${proposal.nodes.find((node) => node.id === selected)?.name ?? "node"}`
            : ""}
      </p>
    </div>
  );
}
