import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, errorMessage, type HarnessApi } from "./api";
import type { MapRef, ProjectMapResponse } from "./project-map";
import { track } from "./track";

export type ProjectMapState =
  | { status: "idle" }
  | { status: "loading" }
  /** `refreshing`: a newer read is in flight; the map on screen stays until it lands. */
  | { status: "ready"; value: ProjectMapResponse; refreshing: boolean }
  | {
      status: "error";
      message: string;
      /** The project is gone or not this account's: no retry helps. */
      unavailable: boolean;
    };

export interface ProjectMapEntry {
  state: ProjectMapState;
  /** The project's git refs from its last drawn map; kept while a read is in
   *  flight or failed, so the ref selector can always lead back. */
  git: ProjectMapResponse["git"];
  /** The git ref drawn: null is the working copy. */
  mapRef: MapRef;
  setMapRef: (ref: MapRef) => void;
  /** Read the map again (the header's refresh). */
  refresh: () => void;
}

interface Options {
  projectId: string | null;
  api: Pick<HarnessApi, "getProjectMap">;
  subscribeProjectMapChanges: (listener: (projectId: string) => void) => () => void;
  subscribeReconnects: (listener: () => void) => () => void;
}

/** Reloads that arrive together (a save touches several files) read once. */
const RELOAD_DEBOUNCE_MS = 250;

/**
 * The open project's map, read from the map tool through the harness
 * (`GET /api/projects/:id/map`). Nothing is cached between reads: a source
 * change on disk, the header's refresh and a ref change each read it again.
 * A read for a project or ref the user has since left is dropped.
 */
export function useProjectMap({
  projectId,
  api,
  subscribeProjectMapChanges,
  subscribeReconnects,
}: Options): ProjectMapEntry {
  const [state, setState] = useState<ProjectMapState>({ status: "idle" });
  // The ref is the project's: leaving a project and coming back draws the
  // ref chosen there (D72), and a new project starts on its working copy.
  const [chosen, setChosen] = useState<Readonly<Record<string, MapRef>>>({});
  const mapRef = projectId ? (chosen[projectId] ?? null) : null;
  const [lastGit, setGit] = useState<{ projectId: string; git: ProjectMapResponse["git"] } | null>(null);
  const request = useRef(0);
  const current = useRef({ projectId, mapRef, api });
  current.current = { projectId, mapRef, api };
  const entered = useRef<string | null>(null);

  const load = useCallback((mode: "open" | "reload") => {
    const { projectId: id, mapRef: ref, api: client } = current.current;
    const generation = ++request.current;
    if (!id) {
      setState({ status: "idle" });
      return;
    }
    // The map on screen stays while another read of the same project (a
    // refresh, a reload, another ref) is in flight.
    setState((previous) =>
      previous.status === "ready" && previous.value.projectId === id
        ? { ...previous, refreshing: true }
        : { status: "loading" },
    );
    const started = performance.now();
    client.getProjectMap(id, ref).then(
      (value) => {
        if (generation !== request.current) return;
        setState({ status: "ready", value, refreshing: false });
        setGit({ projectId: id, git: value.git });
        if (entered.current !== id) {
          entered.current = id;
          track("agent_map.entered", {
            load_ms: Math.round(performance.now() - started),
            agents: value.map.agents.length,
            systems: value.map.systems.length,
          });
        }
      },
      (error: unknown) => {
        if (generation !== request.current) return;
        const unavailable =
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403 || error.status === 404);
        track("agent_map.workspace_load_failed", {
          code: error instanceof ApiError ? (error.code ?? String(error.status)) : "network",
        });
        // A failed reload keeps the map that drew; only a first read shows the error.
        // ...unless the map on screen is another ref's: then the header would
        // name one version while the board shows another.
        setState((previous) =>
          mode === "reload" &&
          previous.status === "ready" &&
          !unavailable &&
          (previous.value.map.ref ?? null) === ref
            ? { ...previous, refreshing: false }
            : {
                status: "error",
                message: errorMessage(error, "The map could not be computed."),
                unavailable,
              },
        );
      },
    );
  }, []);

  useEffect(() => {
    load("open");
    return () => {
      request.current += 1;
    };
  }, [projectId, mapRef, load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => load("reload"), RELOAD_DEBOUNCE_MS);
    };
    const offChanges = subscribeProjectMapChanges((changed) => {
      if (changed === current.current.projectId) reload();
    });
    const offReconnects = subscribeReconnects(reload);
    return () => {
      clearTimeout(timer);
      offChanges();
      offReconnects();
    };
  }, [load, subscribeProjectMapChanges, subscribeReconnects]);

  const refresh = useCallback(() => load("reload"), [load]);
  const setMapRef = useCallback((ref: MapRef) => {
    const id = current.current.projectId;
    if (id) setChosen((previous) => ({ ...previous, [id]: ref }));
  }, []);
  const git = lastGit?.projectId === projectId ? lastGit.git : null;
  return { state, git, mapRef, setMapRef, refresh };
}
