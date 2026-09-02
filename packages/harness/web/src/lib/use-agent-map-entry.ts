import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentMapWorkspaceResponse,
  AcceptedProposalDelta,
  PlannerSessionRequest,
  PlannerSessionResponse,
  StudioProjectId,
} from "@shared/agent-map";
import type { HarnessKind, HarnessSession, UiTheme } from "@shared/types";

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
  | { status: "error"; message: string };

export type AgentMapPlannerPaneState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: PlannerSessionResponse }
  | { status: "error"; message: string };

export interface AgentMapEntryState {
  projectId: StudioProjectId | null;
  workspace: AgentMapWorkspacePaneState;
  planner: AgentMapPlannerPaneState;
  /** Missing/deleted/foreign projects are the only errors that replace both
   * panes. Every ordinary read/launch failure stays local to its own pane. */
  unavailable: string | null;
}

interface AgentMapEntryOptions {
  projectId: StudioProjectId | null;
  /** The user's explicit live planner selection, when it already belongs to
   * this project. It is more specific than project-level resume ordering. */
  selectedPlanner: HarnessSession | null;
  api: HarnessApi;
  /** Read at launch time so a theme/provider change made while the workspace
   * is open is honored by the next explicit fresh-session action. */
  harness: () => HarnessKind;
  theme: () => UiTheme;
  openPlannerSession: (
    projectId: StudioProjectId,
    request: PlannerSessionRequest,
  ) => Promise<PlannerSessionResponse>;
  onPlannerReady: (
    response: PlannerSessionResponse,
    mode: PlannerSessionRequest["mode"],
  ) => void;
  subscribeProposalChanges: (
    listener: (delta: AcceptedProposalDelta) => void,
  ) => () => void;
  subscribeReconnects: (listener: () => void) => () => void;
}

const EMPTY_ENTRY: AgentMapEntryState = {
  projectId: null,
  workspace: { status: "idle" },
  planner: { status: "idle" },
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

function selectedPlannerResponse(
  projectId: StudioProjectId | null,
  session: HarnessSession | null,
): PlannerSessionResponse | null {
  return projectId !== null &&
    session?.status !== "exited" &&
    session?.planning?.identity.role === "map-planner" &&
    session.planning.identity.projectId === projectId
    ? { session, resolution: "live" }
    : null;
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
 * Opens the two halves of the first Agent Map experience concurrently.
 *
 * Workspace reads and planner launches have separate request generations and
 * separate retry verbs. A late response from a project the user already left
 * is ignored. The hook intentionally does not own session state: the returned
 * planner session is handed to the central harness store through
 * `openPlannerSession`, so tabs, status events, and planner metadata share one
 * canonical `HarnessSession` projection.
 */
export function useAgentMapEntry({
  projectId,
  selectedPlanner,
  api,
  harness,
  theme,
  openPlannerSession,
  onPlannerReady,
  subscribeProposalChanges,
  subscribeReconnects,
}: AgentMapEntryOptions): {
  state: AgentMapEntryState;
  retryWorkspace: () => void;
  retryPlanner: () => void;
  retryAll: () => void;
  openFreshPlanner: () => void;
} {
  const [state, setState] = useState<AgentMapEntryState>(EMPTY_ENTRY);
  const currentProjectRef = useRef<StudioProjectId | null>(projectId);
  const startedProjectRef = useRef<StudioProjectId | null>(null);
  const workspaceRequestRef = useRef(0);
  const plannerRequestRef = useRef(0);
  const apiRef = useRef(api);
  const harnessRef = useRef(harness);
  const themeRef = useRef(theme);
  const openPlannerRef = useRef(openPlannerSession);
  const onPlannerReadyRef = useRef(onPlannerReady);
  const visibleProposalRef = useRef(new Map<StudioProjectId, string>());
  const visibleDeltaRef = useRef(
    new Map<StudioProjectId, { proposalId: string; version: number }>(),
  );

  currentProjectRef.current = projectId;
  apiRef.current = api;
  harnessRef.current = harness;
  themeRef.current = theme;
  openPlannerRef.current = openPlannerSession;
  onPlannerReadyRef.current = onPlannerReady;

  const selectedResponse = useMemo(
    () => selectedPlannerResponse(projectId, selectedPlanner),
    [projectId, selectedPlanner],
  );

  const loadWorkspace = useCallback((target: StudioProjectId): void => {
    const request = ++workspaceRequestRef.current;
    setState((current) => ({
      ...(current.projectId === target
        ? current
        : {
            projectId: target,
            planner: { status: "idle" } as AgentMapPlannerPaneState,
            unavailable: null,
          }),
      projectId: target,
      workspace: { status: "loading" },
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
          const latest = value.proposal.history.at(-1);
          track("agent_map.proposal_created", {
            author_role: latest?.actor.role ?? "unknown",
            assignment_kind: latest?.actor.assignment?.kind ?? "none",
          });
        }
        setState((current) =>
          current.projectId === target
            ? { ...current, workspace: { status: "ready", value } }
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
                workspace: { status: "error", message },
                unavailable: isWholeWorkspaceUnavailable(error)
                  ? message
                  : current.unavailable,
              }
            : current,
        );
      },
    );
  }, []);

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
          author_role: delta.actor.role,
          assignment_kind: delta.actor.assignment?.kind ?? "none",
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

  const loadPlanner = useCallback(
    (target: StudioProjectId, mode: PlannerSessionRequest["mode"]): void => {
      const request = ++plannerRequestRef.current;
      setState((current) => ({
        ...(current.projectId === target
          ? current
          : {
              projectId: target,
              workspace: { status: "idle" } as AgentMapWorkspacePaneState,
              unavailable: null,
            }),
        projectId: target,
        planner: { status: "loading" },
      }));
      void openPlannerRef
        .current(target, {
          mode,
          harness: harnessRef.current(),
          theme: themeRef.current(),
        })
        .then(
          (value) => {
            if (
              currentProjectRef.current !== target ||
              plannerRequestRef.current !== request
            )
              return;
            onPlannerReadyRef.current(value, mode);
            setState((current) =>
              current.projectId === target
                ? { ...current, planner: { status: "ready", value } }
                : current,
            );
          },
          (error: unknown) => {
            if (
              currentProjectRef.current !== target ||
              plannerRequestRef.current !== request
            )
              return;
            track("agent_map.workspace_load_failed", {
              ...failureDimensions(target, error),
              pane: "planner",
            });
            const message = errorMessage(
              error,
              "The planning conversation could not be opened.",
            );
            setState((current) =>
              current.projectId === target
                ? {
                    ...current,
                    planner: { status: "error", message },
                    unavailable: isWholeWorkspaceUnavailable(error)
                      ? message
                      : current.unavailable,
                  }
                : current,
            );
          },
        );
    },
    [],
  );

  useEffect(() => {
    if (projectId === null) {
      startedProjectRef.current = null;
      workspaceRequestRef.current += 1;
      plannerRequestRef.current += 1;
      setState(EMPTY_ENTRY);
      return;
    }
    // The ref survives React StrictMode's setup/cleanup probe, preventing two
    // planner launches and duplicate entry telemetry for one visible visit.
    if (startedProjectRef.current === projectId) return;
    startedProjectRef.current = projectId;
    setState({
      projectId,
      workspace: { status: "loading" },
      planner: selectedResponse
        ? { status: "ready", value: selectedResponse }
        : { status: "loading" },
      unavailable: null,
    });
    track("agent_map.entered", { project_id: projectId });
    loadWorkspace(projectId);
    if (!selectedResponse) loadPlanner(projectId, "resume-or-create");
  }, [loadPlanner, loadWorkspace, projectId, selectedResponse]);

  const retryWorkspace = useCallback((): void => {
    const target = currentProjectRef.current;
    if (!target) return;
    setState((current) => ({ ...current, unavailable: null }));
    loadWorkspace(target);
  }, [loadWorkspace]);

  const retryPlanner = useCallback((): void => {
    const target = currentProjectRef.current;
    if (!target) return;
    setState((current) => ({ ...current, unavailable: null }));
    loadPlanner(target, "resume-or-create");
  }, [loadPlanner]);

  const retryAll = useCallback((): void => {
    const target = currentProjectRef.current;
    if (!target) return;
    setState((current) => ({ ...current, unavailable: null }));
    loadWorkspace(target);
    loadPlanner(target, "resume-or-create");
  }, [loadPlanner, loadWorkspace]);

  const openFreshPlanner = useCallback((): void => {
    const target = currentProjectRef.current;
    if (!target) return;
    setState((current) => ({ ...current, unavailable: null }));
    loadPlanner(target, "fresh");
  }, [loadPlanner]);

  return {
    state:
      state.projectId === projectId
        ? state
        : projectId === null
          ? EMPTY_ENTRY
          : {
              projectId,
              workspace: { status: "loading" },
              planner: selectedResponse
                ? { status: "ready", value: selectedResponse }
                : { status: "loading" },
              unavailable: null,
            },
    retryWorkspace,
    retryPlanner,
    retryAll,
    openFreshPlanner,
  };
}
