import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowInfo } from "@shared/types";

import { createApi } from "./api";
import type { GroupNode, LaunchEdge, MaterializedRailState, RailState } from "./agent-groups";
import {
  EMPTY_RAIL_STATE,
  deriveOrStored,
  materialize,
  railStateWrite,
  readRailState,
  resetToDetected,
} from "./agent-groups";
import { rootContains } from "./session-scope";
import type { RailSort } from "./project-tree";

/**
 * The Group axis's live state: one stored arrangement per project root, read
 * from and written to `<root>/.sapiom/studio-rail.json`.
 *
 * Module-level api instance, matching `use-account-plan.ts` — the rail is handed
 * callbacks rather than a client, and these routes are read-mostly.
 */
const api = createApi();

/** Roots are joined into one dependency string; a newline cannot appear in a
 *  path the settings file or a session cwd produced, a space can. */
const ROOTS_SEP = "\n";

export interface RailGroups {
  /** The rows to render for one project root: the stored groups if the user has
   *  any, the derived ones until then, `Ungrouped` last either way. */
  groupsFor: (root: string, workflows: readonly WorkflowInfo[]) => GroupNode[];
  /** The agents this root contains, in registry order. Containment is
   *  `session-scope.rootContains`, the app's ONE answer — an agent files under
   *  every open root that holds it, exactly as on the Project axis. */
  agentsIn: (root: string) => WorkflowInfo[];
  /**
   * Whether this root can be edited yet: its stored arrangement AND the launch
   * edges have both arrived.
   *
   * Both halves matter. Editing before the file lands would write over an
   * arrangement that is still in flight; materializing before the edges land
   * would freeze an EMPTY derived set as the user's own, which is the stuck
   * state `Reset to detected` exists to escape — reached by clicking fast.
   */
  isReady: (root: string) => boolean;
  /** The stored state, for the reset control's copy ("Discards 3 groups"). */
  stateFor: (root: string) => RailState;
  /** Apply a pure operation to one root's arrangement and persist the result.
   *  Materializes first, always: the type demands it, so a user's arrangement
   *  can never be overwritten by a later detection pass. */
  edit: (
    root: string,
    workflows: readonly WorkflowInfo[],
    fn: (state: MaterializedRailState) => MaterializedRailState,
  ) => void;
  /** Hand authority back to detection and ERASE the stored file. Removing rather
   *  than skipping the write is what makes the reset persist. */
  reset: (root: string) => void;
}

/**
 * PERSISTENCE HAPPENS AT THE EDIT, NEVER IN AN EFFECT. This is the whole ticket.
 *
 * The reference prototype synced state to storage from a `useEffect` keyed on
 * the state. That effect also runs on MOUNT, where the state is still
 * un-materialized (`groups: null`) — and serializing that wrote `groups: []`,
 * which means the entirely different thing "the user materialized groups and
 * then deleted every one". So the first page load silently converted "detection
 * owns this" into "the user deleted everything", and from the second load onward
 * every agent fell into `Ungrouped`, in every project, permanently. It read as
 * the group axis never having been built.
 *
 * Fixing the serializer alone would not have been enough, and this is the part
 * worth spelling out: a mount-time sync effect is ALSO wrong in the other
 * direction. Loading is asynchronous, so on mount the state is un-materialized
 * even for a project that does have an arrangement stored — and an effect
 * faithfully persisting "un-materialized" as a file removal would DELETE that
 * file a beat before the read that would have loaded it lands.
 *
 * So there is no sync effect at all. A write is a consequence of an edit, and
 * `commit` below is the only thing in the app that ever touches the file.
 */
export function useRailGroups(
  roots: readonly string[],
  workflows: readonly WorkflowInfo[],
  sort: RailSort,
  enabled: boolean,
): RailGroups {
  const [edges, setEdges] = useState<LaunchEdge[] | null>(null);
  const [states, setStates] = useState<Record<string, RailState>>({});
  const [loaded, setLoaded] = useState<Record<string, true>>({});

  // The registry changes as agents are scanned, and the load effect below must
  // not re-run for that — it would re-read every project's file. It reads the
  // latest registry through a ref instead of depending on it.
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;

  /** Roots a read has already been started for. A ref, not state, so it updates
   *  synchronously and a re-render mid-flight cannot start a second read. */
  const requested = useRef(new Set<string>());

  // Launch edges are a property of the INSTALL, not of a root, so one read
  // serves every project. Fetched only once the axis is in use: it greps every
  // registered agent's sources, and the Project axis has no use for the answer.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api
      .listLaunchEdges()
      .then((next) => {
        if (live) setEdges(next);
      })
      .catch(() => {
        // No edges is a truthful degradation: every agent shows in `Ungrouped`,
        // which is what a repo with no launch calls looks like anyway. Recorded
        // as an empty ARRAY rather than left null so the axis becomes editable —
        // hand-grouping is the whole point when detection finds nothing.
        if (live) setEdges([]);
      });
    return () => {
      live = false;
    };
  }, [enabled]);

  const rootsKey = roots.join(ROOTS_SEP);
  useEffect(() => {
    if (!enabled) return;
    for (const root of rootsKey.split(ROOTS_SEP).filter(Boolean)) {
      if (requested.current.has(root)) continue;
      requested.current.add(root);
      void api
        .getRailState(root)
        .then((raw) => {
          // Parsed against the FULL registry rather than this root's slice: a
          // member path belonging to a neighbouring project is still a real
          // agent, and pruning it here would silently drop it from a file the
          // next edit rewrites.
          setStates((prev) => ({ ...prev, [root]: readRailState(raw, workflowsRef.current) }));
          setLoaded((prev) => ({ ...prev, [root]: true }));
        })
        .catch(() => {
          // An older server with no such route, or an unreadable project. Both
          // read as "nothing stored", which shows the derived groups — but the
          // root stays NOT loaded, so nothing can be edited into a file we were
          // unable to read.
          setStates((prev) => ({ ...prev, [root]: EMPTY_RAIL_STATE }));
        });
    }
  }, [enabled, rootsKey]);

  const stateFor = useCallback(
    (root: string): RailState => states[root] ?? EMPTY_RAIL_STATE,
    [states],
  );

  const isReady = useCallback(
    (root: string): boolean => edges !== null && loaded[root] === true,
    [edges, loaded],
  );

  /**
   * Writes in flight per root, chained.
   *
   * Two edits in quick succession — drag, then reset — are two requests, and
   * concurrent requests can complete out of order. That is not a cosmetic race
   * here: the reset's DELETE finishing before the drag's PUT leaves the file
   * holding the arrangement the reset was meant to erase, which is the stuck
   * state all over again. Chaining makes the file end where the user left off.
   */
  const writeChain = useRef(new Map<string, Promise<void>>());

  /**
   * The ONE place a rail-state file is written. `railStateWrite` returns the
   * DECISION — write this text, or remove the file — so the null/empty
   * distinction cannot be lost at a call site.
   */
  const commit = useCallback((root: string, next: RailState): void => {
    setStates((prev) => ({ ...prev, [root]: next }));
    const write = railStateWrite(next);
    const previous = writeChain.current.get(root) ?? Promise.resolve();
    const persisted = previous.then(() =>
      write.kind === "write" ? api.saveRailState(root, write.raw) : api.clearRailState(root),
    );
    writeChain.current.set(
      root,
      persisted.catch(() => {
        // A read-only checkout or an older server. The arrangement still applies
        // for this session; it simply will not be there next time — and the
        // chain must survive so a later edit still gets its turn.
      }),
    );
  }, []);

  const edit = useCallback(
    (
      root: string,
      rootWorkflows: readonly WorkflowInfo[],
      fn: (state: MaterializedRailState) => MaterializedRailState,
    ): void => {
      if (edges === null || !loaded[root]) return;
      const current = states[root] ?? EMPTY_RAIL_STATE;
      commit(root, fn(materialize(current, rootWorkflows, edges, sort)));
    },
    [commit, edges, loaded, sort, states],
  );

  const reset = useCallback(
    (root: string): void => {
      if (!loaded[root]) return;
      commit(root, resetToDetected(states[root] ?? EMPTY_RAIL_STATE));
    },
    [commit, loaded, states],
  );

  const agentsIn = useCallback(
    (root: string): WorkflowInfo[] =>
      workflows.filter((workflow) => rootContains(root, workflow.path)),
    [workflows],
  );

  const groupsFor = useCallback(
    (root: string, rootWorkflows: readonly WorkflowInfo[]): GroupNode[] =>
      deriveOrStored(rootWorkflows, states[root] ?? EMPTY_RAIL_STATE, edges ?? [], sort),
    [edges, sort, states],
  );

  return useMemo(
    () => ({ groupsFor, agentsIn, isReady, stateFor, edit, reset }),
    [groupsFor, agentsIn, isReady, stateFor, edit, reset],
  );
}
