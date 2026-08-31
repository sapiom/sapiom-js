import type { SystemGraphSnapshot, WorkspaceKey } from "@shared/system-graph";

export interface SystemGraphSource {
  getSystemGraph(
    workspaceKey: WorkspaceKey,
    options?: { refresh?: boolean },
  ): Promise<SystemGraphSnapshot>;
}

export interface SystemGraphLoader {
  load(
    source: SystemGraphSource,
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphSnapshot>;
  /** Invalidates only a newer announcement; omit revision for an explicit retry. */
  invalidate(workspaceKey: WorkspaceKey, revision?: number): boolean;
  /** Drops browser state for workspace scopes Studio no longer exposes. */
  retain(workspaceKeys: ReadonlySet<WorkspaceKey>): void;
  peek(workspaceKey: WorkspaceKey): SystemGraphSnapshot | null;
}

/**
 * Process-lifetime browser cache keyed by the server's opaque workspace key.
 * Revisions invalidate resolved and in-flight requests, and a generation guard
 * makes an older HTTP response follow the newest request instead of poisoning
 * the cache after a source edit.
 */
export function createSystemGraphLoader(): SystemGraphLoader {
  interface WorkspaceLifetime {
    generation: number;
    retired: boolean;
  }

  const requests = new Map<
    WorkspaceKey,
    {
      lifetime: WorkspaceLifetime;
      generation: number;
      explicitRefresh: boolean;
      inFlight: boolean;
      promise: Promise<SystemGraphSnapshot>;
    }
  >();
  const snapshots = new Map<WorkspaceKey, SystemGraphSnapshot>();
  const lifetimes = new Map<WorkspaceKey, WorkspaceLifetime>();
  const announcedRevisions = new Map<WorkspaceKey, number>();
  const forcedReloadGenerations = new Map<WorkspaceKey, number>();
  const retryableSeen = new Set<WorkspaceKey>();
  const retryConsumed = new Set<WorkspaceKey>();

  const lifetimeFor = (workspaceKey: WorkspaceKey): WorkspaceLifetime => {
    const existing = lifetimes.get(workspaceKey);
    if (existing) return existing;
    const lifetime = { generation: 0, retired: false };
    lifetimes.set(workspaceKey, lifetime);
    return lifetime;
  };

  const load = (
    source: SystemGraphSource,
    workspaceKey: WorkspaceKey,
  ): Promise<SystemGraphSnapshot> => {
    const lifetime = lifetimeFor(workspaceKey);
    const generation = lifetime.generation;
    const existing = requests.get(workspaceKey);
    if (existing?.lifetime === lifetime && existing.generation === generation) {
      return existing.promise;
    }

    const cached = snapshots.get(workspaceKey);
    const announcedRevision = announcedRevisions.get(workspaceKey) ?? -1;
    const cachedIsRetryable = cached !== undefined && cached.state !== "ready";
    const shouldRetry =
      cachedIsRetryable &&
      retryableSeen.has(workspaceKey) &&
      !retryConsumed.has(workspaceKey);
    if (
      cached &&
      cached.revision >= announcedRevision &&
      !forcedReloadGenerations.has(workspaceKey) &&
      !shouldRetry
    ) {
      const promise = Promise.resolve(cached);
      requests.set(workspaceKey, {
        lifetime,
        generation,
        explicitRefresh: false,
        inFlight: false,
        promise,
      });
      return promise;
    }
    if (shouldRetry) retryConsumed.add(workspaceKey);
    const explicitRefresh = forcedReloadGenerations.has(workspaceKey);

    let request!: Promise<SystemGraphSnapshot>;
    request = Promise.resolve()
      .then(() =>
        explicitRefresh
          ? source.getSystemGraph(workspaceKey, { refresh: true })
          : source.getSystemGraph(workspaceKey),
      )
      .then((snapshot) => {
        const settledRequest = requests.get(workspaceKey);
        if (settledRequest?.promise === request) {
          settledRequest.inFlight = false;
        }
        if (snapshot.workspaceKey !== workspaceKey) {
          throw new Error("Invalid system graph response");
        }
        if (lifetime.retired) {
          // The scope was retired while this request was in flight. Its caller
          // may finish, but the response cannot repopulate browser state.
          return snapshot;
        }
        const current = snapshots.get(workspaceKey);
        if (current && snapshot.revision < current.revision) {
          return current;
        }
        const newestAnnouncement = announcedRevisions.get(workspaceKey) ?? -1;
        const currentRequest = requests.get(workspaceKey);
        const superseded = lifetime.generation !== generation;
        const latestForcedGeneration =
          forcedReloadGenerations.get(workspaceKey);
        const coversOutstandingForcedReload =
          latestForcedGeneration === undefined ||
          (explicitRefresh && generation >= latestForcedGeneration);
        const satisfiesUnclaimedAnnouncement =
          superseded &&
          currentRequest === undefined &&
          coversOutstandingForcedReload &&
          newestAnnouncement >= 0 &&
          snapshot.revision >= newestAnnouncement;
        if (
          snapshot.revision < newestAnnouncement ||
          (superseded && !satisfiesUnclaimedAnnouncement)
        ) {
          if (requests.get(workspaceKey)?.promise === request) {
            requests.delete(workspaceKey);
          }
          return load(source, workspaceKey);
        }

        snapshots.set(workspaceKey, snapshot);
        forcedReloadGenerations.delete(workspaceKey);
        if (snapshot.state !== "ready" && !retryableSeen.has(workspaceKey)) {
          retryableSeen.add(workspaceKey);
          // A later open gets one recovery attempt. Keep the snapshot itself
          // so the current view can continue showing loading, partial, or
          // last-good data.
          if (requests.get(workspaceKey)?.promise === request) {
            requests.delete(workspaceKey);
          }
        } else if (snapshot.state === "ready") {
          retryableSeen.delete(workspaceKey);
          retryConsumed.delete(workspaceKey);
        }
        return snapshot;
      });
    requests.set(workspaceKey, {
      lifetime,
      generation,
      explicitRefresh,
      inFlight: true,
      promise: request,
    });
    void request.catch(() => {
      if (requests.get(workspaceKey)?.promise === request) {
        requests.delete(workspaceKey);
      }
    });
    return request;
  };

  return {
    load,
    invalidate(workspaceKey, revision) {
      const knownRevision = Math.max(
        snapshots.get(workspaceKey)?.revision ?? -1,
        announcedRevisions.get(workspaceKey) ?? -1,
      );
      if (revision !== undefined && revision <= knownRevision) return false;
      const lifetime = lifetimeFor(workspaceKey);
      const active = requests.get(workspaceKey);
      const forcedGeneration = forcedReloadGenerations.get(workspaceKey);
      const adoptsActiveExplicitRequest =
        revision !== undefined &&
        forcedGeneration !== undefined &&
        active?.lifetime === lifetime &&
        active.generation === lifetime.generation &&
        active.generation >= forcedGeneration &&
        active.explicitRefresh &&
        active.inFlight;
      if (adoptsActiveExplicitRequest) {
        announcedRevisions.set(workspaceKey, revision);
        retryableSeen.delete(workspaceKey);
        retryConsumed.delete(workspaceKey);
        return true;
      }
      lifetime.generation += 1;
      if (revision !== undefined) {
        announcedRevisions.set(workspaceKey, revision);
      } else {
        forcedReloadGenerations.set(workspaceKey, lifetime.generation);
      }
      requests.delete(workspaceKey);
      retryableSeen.delete(workspaceKey);
      retryConsumed.delete(workspaceKey);
      return true;
    },
    retain(workspaceKeys) {
      const cachedKeys = new Set<WorkspaceKey>([
        ...requests.keys(),
        ...snapshots.keys(),
        ...lifetimes.keys(),
        ...announcedRevisions.keys(),
        ...forcedReloadGenerations.keys(),
        ...retryableSeen,
        ...retryConsumed,
      ]);
      for (const workspaceKey of cachedKeys) {
        if (workspaceKeys.has(workspaceKey)) continue;
        const lifetime = lifetimes.get(workspaceKey);
        if (lifetime) lifetime.retired = true;
        lifetimes.delete(workspaceKey);
        requests.delete(workspaceKey);
        snapshots.delete(workspaceKey);
        announcedRevisions.delete(workspaceKey);
        forcedReloadGenerations.delete(workspaceKey);
        retryableSeen.delete(workspaceKey);
        retryConsumed.delete(workspaceKey);
      }
    },
    peek: (workspaceKey) => snapshots.get(workspaceKey) ?? null,
  };
}

/** One cache for the browser tab, invalidated by the global event subscriber. */
export const systemGraphLoader = createSystemGraphLoader();
