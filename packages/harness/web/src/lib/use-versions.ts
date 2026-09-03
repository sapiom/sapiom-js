/**
 * An agent's release history, plus the writes that change what runs.
 *
 * Studio could build and deploy but had no idea what versions existed or which
 * one was live — that lived only in the web dashboard and the API. This hook
 * backs both surfaces that fix it: the Versions tab and the picker beside the
 * agent name.
 *
 * State is NOT held here. It lives in {@link VersionsStore}, keyed by
 * definition, because those surfaces are mounted at the same time and a
 * per-component copy let them disagree: resuming "follow latest" in the tab
 * cleared its pin banner while the header chip still read `· pinned`. This hook
 * only subscribes and forwards the writes.
 *
 * Deliberately NOT polled. History changes only when someone deploys, activates
 * or moves a label — all of which go through here, so a mutation refetches and a
 * timer would just add noise. `reload()` is exposed for a deploy finishing
 * elsewhere in the app.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentVersionsView } from "@shared/types";

import { createApi, ApiError } from "./api";
import { EMPTY_SNAPSHOT, VersionsStore } from "./versions-store";

const api = createApi();

/**
 * Prefer the server's sentence: Core's own words beat a generic string.
 *
 * `reason` is the `{error}` field — the versions router normalises every
 * failure to that shape, so it is Core's human message. `ApiError.message` is
 * NOT usable here: it is a `PUT /api/… → 400: {full json body}` trace built for
 * logs, and putting it in the panel's error banner showed the user a JSON blob
 * with a request id in it.
 */
function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    return err.reason || `request failed (${err.status})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** One store for the app, so every surface reads the same rows. */
const store = new VersionsStore(
  (definitionId, projectDir) => api.getAgentVersions(definitionId, projectDir),
  messageOf,
);

export interface VersionsState {
  readonly view: AgentVersionsView | null;
  readonly loading: boolean;
  /** Human-readable failure for the panel to show inline; null when fine. */
  readonly error: string | null;
  /** The sha whose write is in flight, so a row can show its own spinner. */
  readonly pendingSha: string | null;
  readonly reload: () => void;
  readonly activate: (sha: string) => Promise<void>;
  readonly resumeLatest: () => Promise<void>;
  readonly setLabel: (name: string, sha: string) => Promise<void>;
  readonly removeLabel: (name: string) => Promise<void>;
}

export function useVersions(
  definitionId: string | null,
  /** Absolute project dir, so the server can report the local copy's digest. */
  projectDir: string | null = null,
): VersionsState {
  // A null definition still has to return a stable snapshot, so it shares the
  // store's frozen empty one rather than a fresh object per render.
  const key = definitionId ?? "";
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(key, onChange),
    [key],
  );
  const snapshot = useCallback(
    () => (definitionId ? store.snapshot(key) : EMPTY_SNAPSHOT),
    [definitionId, key],
  );
  const state = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    // Concurrent mounts collapse onto one request inside the store. Rows
    // already cached for this agent stay on screen while it refetches, which
    // beats blanking the list on every remount.
    if (definitionId) void store.load(definitionId, projectDir);
  }, [definitionId, projectDir]);

  const reload = useCallback(() => {
    if (definitionId) void store.load(definitionId, projectDir, { force: true });
  }, [definitionId, projectDir]);

  const mutate = useCallback(
    (sha: string | null, op: () => Promise<void>): Promise<void> => {
      if (!definitionId) return Promise.resolve();
      return store.mutate(definitionId, projectDir, sha, op);
    },
    [definitionId, projectDir],
  );

  return {
    view: state.view,
    loading: state.loading,
    error: state.error,
    pendingSha: state.pendingSha,
    reload,
    activate: (sha) =>
      mutate(sha, () => api.activateAgentVersion(definitionId!, sha)),
    resumeLatest: () =>
      mutate(null, () => api.resumeFollowingLatest(definitionId!)),
    setLabel: (name, sha) =>
      mutate(sha, () => api.setAgentVersionLabel(definitionId!, name, sha)),
    removeLabel: (name) =>
      mutate(null, () => api.removeAgentVersionLabel(definitionId!, name)),
  };
}
