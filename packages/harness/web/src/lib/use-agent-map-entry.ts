import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentMapWorkspaceResponse,
  PlannerSessionRequest,
  PlannerSessionResponse,
  StudioProjectId,
} from "@shared/agent-map";
import type { HarnessKind, UiTheme } from "@shared/types";

import { ApiError, errorMessage, type HarnessApi } from "./api";
import { track } from "./track";

export type AgentMapWorkspacePaneState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: AgentMapWorkspaceResponse }
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
  api,
  harness,
  theme,
  openPlannerSession,
  onPlannerReady,
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

  currentProjectRef.current = projectId;
  apiRef.current = api;
  harnessRef.current = harness;
  themeRef.current = theme;
  openPlannerRef.current = openPlannerSession;
  onPlannerReadyRef.current = onPlannerReady;

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
    void apiRef.current.getAgentMapWorkspace(target).then(
      (value) => {
        if (
          currentProjectRef.current !== target ||
          workspaceRequestRef.current !== request
        )
          return;
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
      planner: { status: "loading" },
      unavailable: null,
    });
    track("agent_map.entered", { project_id: projectId });
    loadWorkspace(projectId);
    loadPlanner(projectId, "resume-or-create");
  }, [loadPlanner, loadWorkspace, projectId]);

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
              planner: { status: "loading" },
              unavailable: null,
            },
    retryWorkspace,
    retryPlanner,
    retryAll,
    openFreshPlanner,
  };
}
