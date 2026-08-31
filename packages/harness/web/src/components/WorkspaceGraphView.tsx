import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type {
  SystemGraphLifecycleState,
  SystemGraphNavigationResponse,
  SystemGraphSnapshot,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "@shared/system-graph";
import type { WorkflowInfo } from "@shared/types";

import type { HarnessApi } from "../lib/api";
import { systemGraphLoader } from "../lib/system-graph-loader";
import { systemGraphNodeGroups } from "../lib/system-graph-groups";
import type { SystemGraphAnnouncement } from "../lib/system-graph-announcements";
import {
  resolveSystemGraphNavigationForRevision,
  systemGraphNavigationForSnapshot,
} from "../lib/system-graph-navigation";
import { useRailGroups } from "../lib/use-rail-groups";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SystemGraphCanvas } from "./SystemGraphCanvas";

interface WorkspaceGraphViewProps {
  workspaceKey: WorkspaceKey;
  workspaceName: string;
  api: HarnessApi;
  workflows: readonly WorkflowInfo[];
  workspaceScopes: readonly WorkspaceScopeSummary[];
  latestAnnouncement: SystemGraphAnnouncement | null;
  /** Drill from a map node into that agent's board — a CUT to the other
   *  altitude, which also moves the rail selection so the two agree. */
  onOpenAgent: (path: string) => void;
}

export function workspaceGraphNavigationIsCurrent(input: {
  snapshotRevision: number | null;
  snapshotState: SystemGraphLifecycleState | null;
  announcementRevision: number | null;
  incomingRevision?: number | null;
  loading: boolean;
  error: boolean;
}): boolean {
  const newestAnnouncement = Math.max(
    input.announcementRevision ?? -1,
    input.incomingRevision ?? -1,
  );
  return (
    !input.loading &&
    !input.error &&
    input.snapshotRevision !== null &&
    (input.snapshotState === "ready" ||
      input.snapshotState === "stale" ||
      input.snapshotState === "degraded") &&
    newestAnnouncement <= input.snapshotRevision
  );
}

export function WorkspaceGraphView({
  workspaceKey,
  workspaceName,
  api,
  workflows,
  workspaceScopes,
  latestAnnouncement,
  onOpenAgent,
}: WorkspaceGraphViewProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<SystemGraphSnapshot | null>(() =>
    systemGraphLoader.peek(workspaceKey),
  );
  const [announcement, setAnnouncement] = useState<{
    revision: number;
    state: SystemGraphLifecycleState;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [navigationResponse, setNavigationResponse] =
    useState<SystemGraphNavigationResponse | null>(null);
  const incomingAnnouncement =
    latestAnnouncement?.workspaceKey === workspaceKey
      ? latestAnnouncement
      : null;
  const effectiveAnnouncement =
    incomingAnnouncement &&
    incomingAnnouncement.revision > (announcement?.revision ?? -1)
      ? incomingAnnouncement
      : announcement;
  const navigationIsCurrent = workspaceGraphNavigationIsCurrent({
    snapshotRevision: snapshot?.revision ?? null,
    snapshotState: snapshot?.state ?? null,
    announcementRevision: announcement?.revision ?? null,
    incomingRevision: incomingAnnouncement?.revision ?? null,
    loading,
    error,
  });
  const navigationResponseMatchesSnapshot =
    navigationIsCurrent &&
    navigationResponse !== null &&
    navigationResponse.workspaceKey === workspaceKey &&
    navigationResponse.revision === snapshot?.revision;

  useEffect(() => {
    let active = true;
    setError(false);
    setLoading(true);
    setNavigationResponse(null);
    void systemGraphLoader.load(api, workspaceKey).then(
      (next) => {
        if (!active) return;
        setSnapshot((current) =>
          current && current.revision > next.revision ? current : next,
        );
        setAnnouncement((current) =>
          current && current.revision > next.revision ? current : null,
        );
        setLoading(false);
      },
      () => {
        if (!active) return;
        setError(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, workspaceKey, refreshSeq]);

  useEffect(() => {
    if (!snapshot?.graph || !navigationIsCurrent) {
      setNavigationResponse(null);
      return;
    }
    const revision = snapshot.revision;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      const resolution = await resolveSystemGraphNavigationForRevision(
        api,
        workspaceKey,
        revision,
        controller.signal,
      );
      if (!active) return;
      if (resolution.kind === "matched") {
        setNavigationResponse(resolution.response);
        return;
      }
      if (resolution.kind === "graph-behind") {
        setNavigationResponse(null);
        systemGraphLoader.invalidate(workspaceKey, resolution.revision);
        setAnnouncement({
          revision: resolution.revision,
          state: "stale",
        });
        setError(false);
        setRefreshSeq((value) => value + 1);
        return;
      }
      setNavigationResponse(null);
    })().catch(() => {
      if (active) setNavigationResponse(null);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, navigationIsCurrent, snapshot?.revision, workspaceKey]);

  useEffect(() => {
    if (
      !latestAnnouncement ||
      latestAnnouncement.workspaceKey !== workspaceKey
    ) {
      return;
    }
    const knownRevision = Math.max(
      snapshot?.revision ?? -1,
      announcement?.revision ?? -1,
    );
    if (latestAnnouncement.revision <= knownRevision) return;
    // The global event subscriber already invalidates the shared cache while
    // this destination is closed. Repeating it here keeps the view correct in
    // isolation and is a no-op for an already-observed revision.
    systemGraphLoader.invalidate(workspaceKey, latestAnnouncement.revision);
    setAnnouncement({
      revision: latestAnnouncement.revision,
      state: latestAnnouncement.state,
    });
    setNavigationResponse(null);
    setError(false);
    setRefreshSeq((value) => value + 1);
  }, [
    announcement?.revision,
    latestAnnouncement,
    snapshot?.revision,
    workspaceKey,
  ]);

  const graph = snapshot?.graph ?? null;
  const announcementIsNewer =
    effectiveAnnouncement !== null &&
    effectiveAnnouncement.revision > (snapshot?.revision ?? -1);
  let lifecycle: SystemGraphLifecycleState = snapshot?.state ?? "building";
  if (announcementIsNewer) {
    lifecycle =
      effectiveAnnouncement.state === "degraded"
        ? "degraded"
        : graph
          ? "stale"
          : "building";
  }
  if (error) lifecycle = snapshot?.graph ? "stale" : "degraded";
  const refreshing =
    !error &&
    graph !== null &&
    (loading ||
      (announcementIsNewer && effectiveAnnouncement?.state !== "degraded"));

  const retry = (): void => {
    systemGraphLoader.invalidate(workspaceKey);
    setAnnouncement(null);
    setNavigationResponse(null);
    setError(false);
    setRefreshSeq((value) => value + 1);
  };

  const navigation = useMemo(
    () =>
      navigationResponseMatchesSnapshot
        ? systemGraphNavigationForSnapshot(navigationResponse, snapshot)
        : new Map<string, string>(),
    [navigationResponse, navigationResponseMatchesSnapshot, snapshot],
  );

  /* THE MAP READS THE RAIL'S GROUPS (SAP-2983).
     The Group axis is stored per project ROOT, and a workspace scope is the one
     thing that joins this opaque key back to one — a graph payload carries no
     filesystem path on purpose.

     A fixed "name" sort rather than the rail's own setting, deliberately: sort
     only settles the order of AGENTS inside a group, and the map re-decides
     that from the topology. Group order — the thing the two surfaces must
     agree on — is size for a derived set and the user's for a stored one, on
     either setting, so reading the rail's preference here would couple the map
     to a control that cannot change its answer. */
  const projectRoot = useMemo(
    () =>
      workspaceScopes.find((scope) => scope.workspaceKey === workspaceKey)
        ?.cwd ?? null,
    [workspaceKey, workspaceScopes],
  );
  const railRoots = useMemo(
    () => (projectRoot === null ? [] : [projectRoot]),
    [projectRoot],
  );
  const railGroups = useRailGroups(
    railRoots,
    workflows,
    "name",
    projectRoot !== null,
  );
  const groups = useMemo(() => {
    /* `hasSettled`, NOT `isReady`. Both need the launch edges and the stored
       arrangement, but `isReady` is the WRITE gate and stays false forever on a
       read that failed — so a map gated on it would fall back to an unlabelled
       flat layout on a read-only checkout while the rail beside it kept showing
       the systems by name. Settled means both surfaces have the same answer.

       Something has to gate it, though: drawing before the edges land would put
       every agent in one `Ungrouped` container for a beat, and that is a real
       arrangement rather than a placeholder — it would read as this project's
       answer and then silently rearrange. */
    if (
      !graph ||
      !navigationResponseMatchesSnapshot ||
      projectRoot === null ||
      !railGroups.hasSettled(projectRoot)
    ) {
      return undefined;
    }
    return systemGraphNodeGroups(
      graph.nodes,
      railGroups.groupsFor(projectRoot, railGroups.agentsIn(projectRoot)),
      navigation,
    );
  }, [
    graph,
    navigation,
    navigationResponseMatchesSnapshot,
    projectRoot,
    railGroups,
  ]);

  return (
    /* The MAP altitude of the right pane (`lib/canvas-altitude.ts`) — a
       project's agents and the edges between them, drawn beside the
       conversation rather than instead of it. */
    <section
      className="workspace-graph-view"
      data-testid="workspace-graph-view"
      aria-label="Workspace dependencies"
    >
      <header className="workspace-graph-bar">
        <Icon name="Folder" size={15} />
        <span
          className="workspace-graph-title"
          title={workspaceName}
          {...trackingAttrs({ object: "workspace" })}
        >
          {workspaceName}
        </span>
        {refreshing && graph && (
          <span
            className="status-tag workspace-graph-lifecycle"
            data-testid="system-graph-refreshing"
            data-state="refreshing"
            role="status"
          >
            <span className="canvas-task-spinner" aria-hidden="true" />
            Refreshing graph
          </span>
        )}
        {lifecycle === "stale" && graph && !refreshing && (
          <span
            className="workspace-graph-lifecycle"
            data-testid="system-graph-stale"
            data-state="stale"
            role="status"
          >
            <span className="status-tag">
              <Icon name="TriangleAlert" size={13} />
              Graph may be out of date
            </span>
            <button
              type="button"
              className="status-tag status-tag-action"
              onClick={retry}
            >
              <Icon name="RefreshCw" size={13} />
              Retry
            </button>
          </span>
        )}
        {lifecycle === "degraded" && graph && (
          <span
            className="workspace-graph-lifecycle"
            data-testid="system-graph-degraded"
            data-state="degraded"
            role="status"
          >
            <span className="status-tag">
              <Icon name="TriangleAlert" size={13} />
              Graph may be incomplete
            </span>
            <button
              type="button"
              className="status-tag status-tag-action"
              onClick={retry}
            >
              <Icon name="RefreshCw" size={13} />
              Retry
            </button>
          </span>
        )}
      </header>

      <div className="workspace-graph-body">
        {!graph && lifecycle === "degraded" ? (
          <EmptyState
            className="system-graph-state"
            testId="system-graph-error"
            icon="TriangleAlert"
            title={
              error
                ? "Couldn't load this workspace graph"
                : "Couldn't build this workspace graph"
            }
            body={
              error
                ? "Studio couldn't load the latest local graph. Check that Studio is still running, then retry."
                : "Studio couldn't produce a usable local projection. Retry after the workspace is readable."
            }
            cta={
              <button type="button" className="btn-primary" onClick={retry}>
                Retry
              </button>
            }
          />
        ) : !graph ? (
          <div
            className="canvas-loading system-graph-state"
            data-testid="system-graph-loading"
          >
            <span className="canvas-task-spinner" aria-hidden="true" />
            <p className="canvas-empty-hint">Loading workspace graph…</p>
          </div>
        ) : graph.nodes.length === 0 && lifecycle === "degraded" ? (
          <EmptyState
            className="system-graph-state"
            testId="system-graph-incomplete"
            icon="TriangleAlert"
            title="Workspace graph is incomplete"
            body="Studio couldn't inspect enough of this workspace to show a reliable graph."
            cta={
              <button type="button" className="btn-primary" onClick={retry}>
                Retry
              </button>
            }
          />
        ) : graph.nodes.length === 0 ? (
          <EmptyState
            className="system-graph-state"
            testId="system-graph-empty"
            icon="Frame"
            title="No agents in this workspace"
            body="Agent projects discovered inside this folder will appear here."
          />
        ) : (
          <SystemGraphCanvas
            graph={graph}
            workspaceKey={workspaceKey}
            navigableAgentKeys={new Set(navigation.keys())}
            groups={groups}
            onOpenAgent={(agentKey) => {
              const workflowPath = navigation.get(agentKey);
              if (workflowPath) onOpenAgent(workflowPath);
            }}
          />
        )}
      </div>
    </section>
  );
}
