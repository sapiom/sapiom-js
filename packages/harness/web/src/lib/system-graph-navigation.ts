import type {
  AgentKey,
  SystemGraphNavigationResponse,
  SystemGraphSnapshot,
  WorkspaceKey,
} from "@shared/system-graph";

interface SystemGraphNavigationSource {
  getSystemGraphNavigation(
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphNavigationResponse>;
}

export type SystemGraphNavigationResolution =
  | { kind: "matched"; response: SystemGraphNavigationResponse }
  | { kind: "graph-behind"; revision: number }
  | { kind: "unavailable" };

/** Give a resolver that lost a commit race a moment to catch up. */
function backOffBeforeRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
}

/**
 * Resolve the path-bearing sidecar against the graph revision currently on
 * screen. An older response may have straddled a graph commit, so retry it;
 * a newer one asks the caller to advance the graph. Foreign, failed, and
 * repeatedly stale responses all fail closed.
 */
export async function resolveSystemGraphNavigationForRevision(
  source: SystemGraphNavigationSource,
  workspaceKey: WorkspaceKey,
  revision: number,
  signal?: AbortSignal,
  waitBeforeRetry: (attempt: number) => Promise<void> = backOffBeforeRetry,
): Promise<SystemGraphNavigationResolution> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal?.aborted) return { kind: "unavailable" };
    if (attempt > 0) {
      await waitBeforeRetry(attempt - 1);
      if (signal?.aborted) return { kind: "unavailable" };
    }
    try {
      const response = await source.getSystemGraphNavigation(workspaceKey);
      if (signal?.aborted) return { kind: "unavailable" };
      if (response.workspaceKey !== workspaceKey)
        return { kind: "unavailable" };
      if (response.revision === revision) return { kind: "matched", response };
      if (response.revision > revision) {
        return { kind: "graph-behind", revision: response.revision };
      }
    } catch {
      if (signal?.aborted) return { kind: "unavailable" };
      // Resolver paths are read-only and cheap. Retry a transient failure
      // within the same bounded race loop before failing closed.
    }
  }
  return { kind: "unavailable" };
}

/**
 * Accept resolver paths only for the exact graph revision on screen. The
 * server owns identity resolution; this helper merely joins two revisioned
 * responses and refuses stale, foreign, or non-node targets.
 */
export function systemGraphNavigationForSnapshot(
  response: SystemGraphNavigationResponse | null,
  snapshot: SystemGraphSnapshot | null,
): ReadonlyMap<AgentKey, string> {
  if (
    !response ||
    !snapshot?.graph ||
    response.workspaceKey !== snapshot.workspaceKey ||
    response.revision !== snapshot.revision
  ) {
    return new Map();
  }
  const graphKeys = new Set(snapshot.graph.nodes.map((node) => node.agentKey));
  return new Map(
    response.targets
      .filter((target) => graphKeys.has(target.agentKey))
      .map((target) => [target.agentKey, target.workflowPath] as const),
  );
}
