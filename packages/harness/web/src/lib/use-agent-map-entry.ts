import type { AgentMapInitializationStatus } from "@shared/agent-map-initialization";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentMapWorkspaceResponse,
  AcceptedProposalDelta,
  StudioProjectId,
} from "@shared/agent-map";

import { ApiError, errorMessage, type HarnessApi } from "./api";
import { track } from "./track";
import { agentMapLoader } from "./agent-map-loader";
import { routeAcceptedProposalDelta } from "./agent-map";

export type AgentMapWorkspacePaneState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      value: AgentMapWorkspaceResponse;
    }
  | { status: "error"; message: string; canRetry?: boolean };

export interface AgentMapEntryState {
  projectId: StudioProjectId | null;
  workspace: AgentMapWorkspacePaneState;
  /** Missing/deleted/foreign projects are bounded separately from ordinary
   * map-read failures so the renderer can present the right recovery copy. */
  unavailable: string | null;
}

interface AgentMapEntryOptions {
  projectId: StudioProjectId | null;
  api: HarnessApi;
  subscribeInitializationChanges?: (
    listener: (status: AgentMapInitializationStatus) => void,
  ) => () => void;
  subscribeProposalChanges: (
    listener: (delta: AcceptedProposalDelta) => void,
  ) => () => void;
  subscribeReconnects: (listener: () => void) => () => void;
}

const EMPTY_ENTRY: AgentMapEntryState = {
  projectId: null,
  workspace: { status: "idle" },
  unavailable: null,
};

function isWholeWorkspaceUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function failureDimensions(
  projectId: StudioProjectId,
  error: unknown,
): Record<string, string | number> {
  return {
    project_id: projectId,
    error_kind:
      error instanceof ApiError
        ? error.status === 401 || error.status === 403
          ? "unauthorized"
          : error.status === 404
            ? "project_not_found"
            : "request_failed"
        : "network_or_client_error",
    ...(error instanceof ApiError ? { http_status: error.status } : {}),
  };
}

/** The shared gate before an accepted delta may mutate state or telemetry. */
export function shouldCommitAcceptedDelta(
  currentProjectId: StudioProjectId | null,
  projectId: StudioProjectId,
  currentWorkspaceRequest: number,
  workspaceRequest: number,
  snapshot: AgentMapWorkspaceResponse,
  delta: AcceptedProposalDelta,
): boolean {
  return (
    currentProjectId === projectId &&
    currentWorkspaceRequest === workspaceRequest &&
    snapshot.proposal?.id === delta.proposalId &&
    snapshot.proposal.version >= delta.version
  );
}

/**
 * Loads the durable Agent Map for the selected project.
 *
 * This hook deliberately owns no session behavior. Selecting a project is a
 * read-only navigation action: it may read map state, but it cannot create,
 * resume, focus, or prompt a coding session. A late response from a project the
 * user already left is ignored.
 */
export function useAgentMapEntry({
  projectId,
  api,
  subscribeProposalChanges,
  subscribeInitializationChanges,
  subscribeReconnects,
}: AgentMapEntryOptions): {
  state: AgentMapEntryState;
  retryWorkspace: () => void;
  initialization: AgentMapInitializationStatus | null;
  retryGeneration: () => void;
} {
  const [initialization, setInitialization] =
    useState<AgentMapInitializationStatus | null>(null);
  const initializationRevisionRef = useRef(0);
  const [initializationLoadError, setInitializationLoadError] = useState<
    string | null
  >(null);
  const refreshInitializationRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<AgentMapEntryState>(EMPTY_ENTRY);
  const currentProjectRef = useRef<StudioProjectId | null>(projectId);
  const startedProjectRef = useRef<StudioProjectId | null>(null);
  const workspaceRequestRef = useRef(0);
  const apiRef = useRef(api);
  const visibleProposalRef = useRef(new Map<StudioProjectId, string>());
  const visibleDeltaRef = useRef(
    new Map<StudioProjectId, { proposalId: string; version: number }>(),
  );

  currentProjectRef.current = projectId;
  apiRef.current = api;

  const loadWorkspace = useCallback(
    (target: StudioProjectId, quiet = false): void => {
      const request = ++workspaceRequestRef.current;
      setState((current) => ({
        ...(current.projectId === target
          ? current
          : {
              projectId: target,
              unavailable: null,
            }),
        projectId: target,
        unavailable: null,
        workspace:
          quiet &&
          current.projectId === target &&
          current.workspace.status === "ready"
            ? current.workspace
            : { status: "loading" },
      }));
      void agentMapLoader.load(apiRef.current, target).then(
        (value) => {
          if (
            currentProjectRef.current !== target ||
            workspaceRequestRef.current !== request
          )
            return;
          if (
            value.proposal &&
            visibleProposalRef.current.get(target) !== value.proposal.id
          ) {
            visibleProposalRef.current.set(target, value.proposal.id);
            track("agent_map.proposal_created");
          }
          setState((current) =>
            current.projectId === target
              ? {
                  ...current,
                  unavailable: null,
                  workspace: { status: "ready", value },
                }
              : current,
          );
        },
        (error: unknown) => {
          if (
            currentProjectRef.current !== target ||
            workspaceRequestRef.current !== request
          )
            return;
          track("agent_map.workspace_load_failed", {
            ...failureDimensions(target, error),
            pane: "map",
          });
          const message = errorMessage(
            error,
            "Agent Map state could not be loaded.",
          );
          setState((current) =>
            current.projectId === target
              ? {
                  ...current,
                  workspace: {
                    status: "error",
                    message,
                    canRetry: !(
                      error instanceof ApiError &&
                      (error.code === "malformed_state" ||
                        error.code === "unsupported_schema")
                    ),
                  },
                  unavailable: isWholeWorkspaceUnavailable(error)
                    ? message
                    : null,
                }
              : current,
          );
        },
      );
    },
    [],
  );

  useEffect(() => {
    if (!projectId) return;
    const unsubscribeChanges = subscribeProposalChanges((rawDelta) => {
      // Route before comparing with the active view. A foreign but valid delta
      // still belongs in that project's cache and must never refetch this one.
      const routed = routeAcceptedProposalDelta(rawDelta, projectId);
      if (routed.status === "malformed-active") {
        agentMapLoader.invalidate(projectId);
        loadWorkspace(projectId);
        return;
      }
      if (routed.status === "ignored") {
        return;
      }
      const delta = routed.delta;
      const workspaceRequest = workspaceRequestRef.current;
      const outcome = agentMapLoader.accept(delta);
      if (delta.projectId !== projectId) return;
      const showAcceptedDelta = (snapshot: AgentMapWorkspaceResponse): void => {
        if (
          !shouldCommitAcceptedDelta(
            currentProjectRef.current,
            projectId,
            workspaceRequestRef.current,
            workspaceRequest,
            snapshot,
            delta,
          )
        )
          return;
        const previous = visibleDeltaRef.current.get(projectId);
        if (
          previous?.proposalId === delta.proposalId &&
          previous.version >= delta.version
        )
          return;
        visibleDeltaRef.current.set(projectId, {
          proposalId: delta.proposalId,
          version: delta.version,
        });
        const visibleLatency = Math.max(
          0,
          Math.min(60_000, Date.now() - Date.parse(delta.acceptedAt)),
        );
        // State and telemetry share the same request-generation gate: a
        // superseded arm can neither overwrite the pane nor claim it rendered.
        setState((current) =>
          current.projectId === projectId
            ? {
                ...current,
                workspace: {
                  status: "ready",
                  value: snapshot,
                },
              }
            : current,
        );
        track("agent_map.proposal_visible", {
          visible_latency_ms: visibleLatency,
        });
      };
      if (outcome.status === "applied") {
        showAcceptedDelta(outcome.snapshot);
      } else if (outcome.status === "queued") {
        // A delta can beat the cold GET. The loader replays it before settling
        // that shared promise; report visibility only after the replayed
        // snapshot is actually ready, with the same dedupe as the direct path.
        void agentMapLoader.load(apiRef.current, projectId).then(
          (snapshot) => {
            if (agentMapLoader.includesQueuedDelta(snapshot, delta))
              showAcceptedDelta(snapshot);
          },
          () => undefined,
        );
      } else if (outcome.status === "needs-refetch") {
        loadWorkspace(projectId);
      }
    });
    const unsubscribeReconnects = subscribeReconnects(() => {
      agentMapLoader.invalidate(projectId);
      loadWorkspace(projectId);
    });
    return () => {
      unsubscribeChanges();
      unsubscribeReconnects();
    };
  }, [loadWorkspace, projectId, subscribeProposalChanges, subscribeReconnects]);

  useEffect(() => {
    if (projectId === null) {
      startedProjectRef.current = null;
      workspaceRequestRef.current += 1;
      setState(EMPTY_ENTRY);
      return;
    }
    // The ref survives React StrictMode's setup/cleanup probe, preventing two
    // map reads and duplicate entry telemetry for one visible visit.
    if (startedProjectRef.current === projectId) return;
    startedProjectRef.current = projectId;
    setState({
      projectId,
      workspace: { status: "loading" },
      unavailable: null,
    });
    track("agent_map.entered", { project_id: projectId });
    loadWorkspace(projectId);
  }, [loadWorkspace, projectId]);

  useEffect(() => {
    setInitialization(null);
    setInitializationLoadError(null);
    if (!projectId) return;
    let disposed = false;
    const show = (status: AgentMapInitializationStatus) => {
      if (disposed || status.projectId !== projectId) return;
      setInitializationLoadError(null);
      setInitialization(status);
      if (
        (status.status === "completed" || status.status === "skipped") &&
        !agentMapLoader.peek(projectId)?.proposal
      ) {
        agentMapLoader.invalidate(projectId);
        loadWorkspace(projectId, true);
      }
    };
    const refresh = () => {
      const started = ++initializationRevisionRef.current;
      void api
        .getAgentMapInitialization(projectId)
        .then((status) => {
          if (initializationRevisionRef.current === started) show(status);
        })
        .catch(() => {
          if (!disposed && initializationRevisionRef.current === started)
            setInitializationLoadError(
              "Agent Map generation status could not be loaded.",
            );
        });
    };
    const unsubscribe = subscribeInitializationChanges?.((status) => {
      if (status.projectId !== projectId) return;
      initializationRevisionRef.current += 1;
      show(status);
    });
    const reconnect = subscribeReconnects(refresh);
    refreshInitializationRef.current = refresh;
    refresh();
    return () => {
      disposed = true;
      refreshInitializationRef.current = null;
      unsubscribe?.();
      reconnect();
    };
  }, [
    api,
    projectId,
    subscribeInitializationChanges,
    subscribeReconnects,
    loadWorkspace,
  ]);

  useEffect(() => {
    if (!projectId || initialization?.projectId !== projectId) return;
    if (
      initialization.status !== "queued" &&
      initialization.status !== "running"
    )
      return;
    let disposed = false;
    let inFlight = false;
    // Another Studio process may own the job. Its local event bus cannot notify
    // this tab, so only active initialization polls its durable project status.
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      const started = ++initializationRevisionRef.current;
      void api
        .getAgentMapInitialization(projectId)
        .then((status) => {
          if (
            disposed ||
            currentProjectRef.current !== projectId ||
            initializationRevisionRef.current !== started
          )
            return;
          setInitialization(status);
          setInitializationLoadError(null);
          if (status.status === "completed" || status.status === "skipped") {
            agentMapLoader.invalidate(projectId);
            loadWorkspace(projectId, true);
          }
        })
        .catch(() => {
          if (!disposed && initializationRevisionRef.current === started)
            setInitializationLoadError(
              "Agent Map generation status could not be loaded.",
            );
        })
        .finally(() => {
          inFlight = false;
        });
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api, initialization, projectId, loadWorkspace]);

  const retryGeneration = useCallback(() => {
    if (!projectId) return;
    const started = ++initializationRevisionRef.current;
    void api
      .retryAgentMapInitialization(projectId)
      .then((status) => {
        if (
          currentProjectRef.current === projectId &&
          initializationRevisionRef.current === started
        ) {
          setInitialization(status);
          setInitializationLoadError(null);
        }
      })
      .catch(() => {
        if (currentProjectRef.current === projectId) loadWorkspace(projectId);
      });
  }, [api, projectId, loadWorkspace]);

  const retryWorkspace = useCallback((): void => {
    const target = currentProjectRef.current;
    if (!target) return;
    setState((current) => ({ ...current, unavailable: null }));
    refreshInitializationRef.current?.();
    loadWorkspace(target);
  }, [loadWorkspace]);

  return {
    state:
      state.projectId === projectId
        ? initializationLoadError &&
          state.workspace.status === "ready" &&
          !state.workspace.value.proposal
          ? {
              ...state,
              workspace: {
                status: "error",
                message: initializationLoadError,
                canRetry: true,
              },
            }
          : state
        : projectId === null
          ? EMPTY_ENTRY
          : {
              projectId,
              workspace: { status: "loading" },
              unavailable: null,
            },
    retryWorkspace,
    initialization:
      initialization?.projectId === projectId ? initialization : null,
    retryGeneration,
  };
}
