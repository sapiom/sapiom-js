import type { WorkflowInfo } from "@shared/types";

import type { AgentNode, RailSort } from "./project-tree";

/**
 * The GROUP axis: what an agent is RELATED to.
 *
 * The Project axis answers where an agent LIVES, and the filesystem is the only
 * authority on that. This axis answers the question the disk cannot: which
 * agents call or depend on each other. It has two halves, and both live here.
 *
 *  - **Derivation** (`buildGroupTree`) reads the launch edges — the same
 *    `agents.launch({definition})` / `orchestrations.launch(...)` grep the
 *    canvas draws its dashed launched-workflow nodes from — and files each
 *    connected component as a group named for its head.
 *  - **The membership model** (everything below it) owns what the user did to
 *    those groups and how it survives a reload.
 *
 * Two rules shape all of it:
 *
 *  1. **Derived until touched.** With nothing stored, the rail shows the derived
 *     groups. The FIRST edit materializes the derived set and the user owns it
 *     from then on. Without that step detection would re-run on the next reload
 *     and quietly overwrite the arrangement someone just dragged into place.
 *  2. **A group is a label over agents.** Editing one moves nothing on disk.
 *     Membership is many-to-many — a shared subagent belongs to every system
 *     that uses it — but it may never appear twice in the same group: two
 *     identical rows in one group are unresolvable by looking at them.
 *
 * Pure and React-free on purpose, so the rules above are pinned by unit tests
 * rather than by whatever the rail happens to render.
 */

/** One detected launch edge, by NAME: `parent` launches `child`. */
export interface LaunchEdge {
  parent: string;
  child: string;
}

/**
 * A semantic cluster on the `group` axis.
 *
 * `id` is the collapse key too, namespaced `group:` like every other row kind —
 * a path is not unique across kinds, and one shared key folded two different
 * things at once.
 */
export interface GroupNode {
  id: string;
  label: string;
  agents: AgentNode[];
  /**
   * The honest bucket for agents no launch edge touches. Most agents in a real
   * repo launch nothing, so hiding them would make the axis lie by omission;
   * naming the bucket is what keeps it truthful before anyone has done any
   * hand-grouping.
   */
  isUngrouped: boolean;
}

/** One stored group. `members` are absolute agent paths. */
export interface StoredGroup {
  id: string;
  label: string;
  members: string[];
}

/**
 * `.sapiom/studio-rail.json`, one file per project root.
 *
 * `groups: null` is "nothing stored yet" — the un-materialized state, which is
 * what an absent or unreadable file reads as. It is deliberately NOT the same as
 * `groups: []`: an empty array means the user materialized and then deleted
 * every group, and must keep showing no groups rather than resurrecting the
 * derived ones on the next reload.
 *
 * `renames` is carried but not interpreted here — it rides in the same file, so
 * every operation preserves it untouched rather than making the rail merge two
 * blobs.
 */
export interface RailState {
  version: 1;
  groups: StoredGroup[] | null;
  renames: Record<string, string>;
}

/**
 * A state whose groups exist. Every mutating operation demands one, so "the
 * first edit materializes" is enforced by the TYPE rather than by remembering to
 * call `materialize` — a forgotten call is exactly how a user's first drag gets
 * eaten by detection later.
 */
export type MaterializedRailState = RailState & { groups: StoredGroup[] };

/** Nothing stored. Safe to share: every function here returns a new object and
 *  none mutates its input. */
export const EMPTY_RAIL_STATE: RailState = { version: 1, groups: null, renames: {} };

/**
 * Kept identical to the id `buildGroupTree` uses, so collapsing Ungrouped before
 * the first edit leaves it collapsed after materialization — the row did not
 * change, only where its contents come from.
 */
export const UNGROUPED_ID = "group:ungrouped";

export const isMaterialized = (state: RailState): state is MaterializedRailState =>
  state.groups !== null;

// ---------------------------------------------------------------------------
// Derivation from launch edges
// ---------------------------------------------------------------------------

/**
 * The group axis files by RELATIONSHIP, so a directory prefix is context for a
 * question nobody asked here. Both prefix fields stay empty and `WorkflowRow`
 * renders the bare name.
 */
const toAgentNode = (workflow: WorkflowInfo): AgentNode => ({
  workflow,
  prefix: "",
  prefixFull: "",
});

/**
 * Row order inside a group. Mirrors project-tree's agent order: `WorkflowInfo`
 * carries no timestamp, so "recent" cannot mean anything for an agent row and
 * both settings resolve to something path-stable.
 */
const agentOrder =
  (sort: RailSort) =>
  (a: AgentNode, b: AgentNode): number =>
    sort === "name"
      ? a.workflow.name.localeCompare(b.workflow.name)
      : a.workflow.path.localeCompare(b.workflow.path);

/**
 * GROUP axis derivation: connected components over the launch edges.
 *
 * An edge joins two agents only where BOTH ends are agents this install actually
 * has. An edge to an agent you do not have is not a group of one plus a ghost;
 * it is simply not an edge you can draw. A slug matches by `definitionSlug`
 * first and by folder name second, because a launch call names the deployed
 * definition and a local project may not be linked yet.
 *
 * A component of one is NOT a group. One agent alone is not a relationship, and
 * a rail of one-member groups says nothing the Project axis did not already say
 * — those agents fall to `Ungrouped`.
 *
 * This is the same relationship graph the system map draws, filed as rows rather
 * than laid out as nodes. If the two ever disagree, one of them is reading the
 * edges wrong.
 */
export function buildGroupTree(
  workflows: readonly WorkflowInfo[],
  edges: readonly LaunchEdge[],
  sort: RailSort = "recent",
): GroupNode[] {
  // Later entries lose: within one project the FIRST spelling of a name wins,
  // matching the project axis's own first-spelling-wins rule for roots.
  const byName = new Map<string, WorkflowInfo>();
  for (const workflow of workflows) {
    if (workflow.definitionSlug && !byName.has(workflow.definitionSlug)) {
      byName.set(workflow.definitionSlug, workflow);
    }
    if (!byName.has(workflow.name)) byName.set(workflow.name, workflow);
  }

  /** Only the edges whose BOTH ends are agents in this set, by path. */
  const resolved: Array<{ parent: WorkflowInfo; child: WorkflowInfo }> = [];
  for (const edge of edges) {
    const parent = byName.get(edge.parent);
    const child = byName.get(edge.child);
    if (!parent || !child || parent.path === child.path) continue;
    resolved.push({ parent, child });
  }

  // Union-find over workflow PATHS — the row's identity. Two agents can share a
  // name (`ads` in two directories) and unioning by name would merge two
  // unrelated systems into one group.
  const parentOf = new Map<string, string>();
  for (const workflow of workflows) parentOf.set(workflow.path, workflow.path);
  const find = (x: string): string => {
    let root = x;
    while (parentOf.get(root) !== root) root = parentOf.get(root) ?? root;
    while (parentOf.get(x) !== root) {
      const next = parentOf.get(x) ?? root;
      parentOf.set(x, root);
      x = next;
    }
    return root;
  };
  for (const edge of resolved) {
    const a = find(edge.parent.path);
    const b = find(edge.child.path);
    if (a !== b) parentOf.set(a, b);
  }

  const components = new Map<string, WorkflowInfo[]>();
  for (const workflow of workflows) {
    const key = find(workflow.path);
    const bucket = components.get(key);
    if (bucket) bucket.push(workflow);
    else components.set(key, [workflow]);
  }

  /**
   * The member no other member launches — the head of the cluster, and the
   * thing the cluster is about. Falling back to the alphabetically first member
   * keeps a cycle from leaving the group unnamed.
   */
  const headOf = (members: readonly WorkflowInfo[]): WorkflowInfo => {
    const paths = new Set(members.map((member) => member.path));
    const launched = new Set(
      resolved
        .filter((edge) => paths.has(edge.parent.path) && paths.has(edge.child.path))
        .map((edge) => edge.child.path),
    );
    const rootward = members.filter((member) => !launched.has(member.path));
    const candidates = rootward.length > 0 ? rootward : members;
    return [...candidates].sort((a, b) => a.name.localeCompare(b.name))[0];
  };

  const groups: GroupNode[] = [];
  const ungrouped: WorkflowInfo[] = [];
  for (const members of components.values()) {
    if (members.length < 2) {
      ungrouped.push(...members);
      continue;
    }
    const head = headOf(members);
    groups.push({
      id: `group:${head.path}`,
      label: head.name,
      agents: members.map(toAgentNode).sort(agentOrder(sort)),
      isUngrouped: false,
    });
  }
  // Biggest system first: a derived group has no author to have arranged it, so
  // the only order it can honestly carry is one derived from the graph too.
  groups.sort((a, b) => b.agents.length - a.agents.length || a.label.localeCompare(b.label));

  if (ungrouped.length > 0) {
    groups.push({
      id: UNGROUPED_ID,
      label: "Ungrouped",
      agents: ungrouped.map(toAgentNode).sort(agentOrder(sort)),
      isUngrouped: true,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Parsing and serializing
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dedupe = (paths: readonly string[]): string[] => [...new Set(paths)];

/** A group is only as good as its id: without one, nothing can address it. */
function parseGroup(value: unknown): StoredGroup | null {
  if (!isRecord(value)) return null;
  const { id, label, members } = value;
  if (typeof id !== "string" || id === "") return null;
  return {
    id,
    label: typeof label === "string" && label !== "" ? label : id,
    members: dedupe(
      Array.isArray(members) ? members.filter((m): m is string => typeof m === "string") : [],
    ),
  };
}

const parseRenames = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const renames: Record<string, string> = {};
  for (const [path, name] of Object.entries(value)) {
    if (typeof name === "string") renames[path] = name;
  }
  return renames;
};

/**
 * Field-by-field, because this file is on disk where anything can happen to it —
 * a half-written save, a hand edit, a future version. A rail that throws on a
 * bad preferences file is a rail you cannot open in order to fix it, so every
 * unreadable shape degrades to "nothing stored" and the derived groups show.
 *
 * An unknown `version` is treated the same way: a later shape is not ours to
 * guess at, and guessing wrong would write the mangled result back.
 */
export function parseRailState(raw: string | null | undefined): RailState {
  if (!raw) return EMPTY_RAIL_STATE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_RAIL_STATE;
  }
  if (!isRecord(value) || value.version !== 1) return EMPTY_RAIL_STATE;
  return {
    version: 1,
    groups: Array.isArray(value.groups)
      ? value.groups.map(parseGroup).filter((group): group is StoredGroup => group !== null)
      : null,
    renames: parseRenames(value.renames),
  };
}

/**
 * `groups: null` is written out as null, NOT as `[]`.
 *
 * The distinction has to survive the file or it is not a distinction: `[]` is
 * "the user deleted every group", and coercing an un-materialized state into it
 * would write the exact stuck state `resetToDetected` exists to escape — reset
 * the rail, save, reload, and detection would be gone again.
 *
 * An absent file and a null `groups` mean the same thing on read, which is why
 * the only correct way to persist an un-materialized state is to REMOVE the
 * file (`railStateWrite` below returns exactly that instruction) — this
 * serializer exists for the materialized case and for the tests that pin the
 * null encoding.
 */
export function serializeRailState(state: RailState): string {
  return `${JSON.stringify({ version: 1, groups: state.groups, renames: state.renames }, null, 2)}\n`;
}

/**
 * What persisting a state MEANS, as a value rather than as an `if` at each call
 * site: write this text, or remove the file.
 *
 * This is the shape of the bug the ticket is about. In the reference prototype a
 * persistence effect ran on mount, serialized an un-materialized state, and got
 * `groups: []` — so the first page load converted "detection owns this" into
 * "the user deleted everything", and from the second load on every agent fell
 * into `Ungrouped`, in every project, permanently. Returning the *decision*
 * makes it testable without a browser, and makes "remove" impossible to forget:
 * skipping the write instead would let an old arrangement outlive a reset.
 */
export type RailStateWrite = { kind: "write"; raw: string } | { kind: "remove" };

export const railStateWrite = (state: RailState): RailStateWrite =>
  isMaterialized(state) ? { kind: "write", raw: serializeRailState(state) } : { kind: "remove" };

/**
 * Drops member paths no known agent claims.
 *
 * Agents get moved, renamed and deleted outside the studio, and a group is the
 * one place holding paths that nothing on disk keeps honest. A stale path would
 * otherwise render as a row for an agent that isn't there. It goes quietly: the
 * file is not an error report, and the user did nothing wrong.
 *
 * Renames are left alone — a stale rename never renders, so pruning it only
 * risks losing a name the user set on an agent whose project is closed right
 * now.
 */
export function pruneRailState(state: RailState, workflows: readonly WorkflowInfo[]): RailState {
  if (!isMaterialized(state)) return state;
  const known = new Set(workflows.map((workflow) => workflow.path));
  let dropped = false;
  const groups = state.groups.map((group) => {
    const members = group.members.filter((path) => known.has(path));
    if (members.length === group.members.length) return group;
    dropped = true;
    return { ...group, members };
  });
  return dropped ? { ...state, groups } : state;
}

/** Read a stored file: parse defensively, then prune what no longer exists. */
export const readRailState = (
  raw: string | null | undefined,
  workflows: readonly WorkflowInfo[],
): RailState => pruneRailState(parseRailState(raw), workflows);

// ---------------------------------------------------------------------------
// Derive, materialize
// ---------------------------------------------------------------------------

/** Agents no stored group claims. Derived, never stored: a group the user did
 *  not make is not a group they can edit, and storing it would let membership
 *  and non-membership disagree. */
export function ungroupedAgents(
  workflows: readonly WorkflowInfo[],
  groups: readonly StoredGroup[],
): WorkflowInfo[] {
  const claimed = new Set(groups.flatMap((group) => group.members));
  return workflows.filter((workflow) => !claimed.has(workflow.path));
}

/**
 * What the rail renders: the stored groups once they exist, the derived ones
 * until then.
 *
 * Stored groups keep the USER's order — they arranged them, and re-sorting by
 * size on every reload would shuffle the rail under someone who put a group
 * where they wanted it. Derived groups have no such author, so `buildGroupTree`
 * sorts them by size. Ungrouped is last either way.
 */
export function deriveOrStored(
  workflows: readonly WorkflowInfo[],
  state: RailState,
  edges: readonly LaunchEdge[],
  sort: RailSort = "recent",
): GroupNode[] {
  if (!isMaterialized(state)) return buildGroupTree(workflows, edges, sort);

  const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow]));
  const order = agentOrder(sort);
  const nodes: GroupNode[] = state.groups.map((group) => ({
    id: group.id,
    label: group.label,
    // Unknown paths are skipped here too, so a caller that renders without
    // pruning first still gets rows only for agents that exist.
    agents: group.members
      .map((path) => byPath.get(path))
      .filter((workflow): workflow is WorkflowInfo => workflow !== undefined)
      .map(toAgentNode)
      .sort(order),
    isUngrouped: false,
  }));

  const rest = ungroupedAgents(workflows, state.groups);
  if (rest.length > 0) {
    nodes.push({
      id: UNGROUPED_ID,
      label: "Ungrouped",
      agents: rest.map(toAgentNode).sort(order),
      isUngrouped: true,
    });
  }
  return nodes;
}

/**
 * Freezes the currently-derived groups into storage. Called on the FIRST edit —
 * that is the whole point: from this moment detection stops having an opinion,
 * so the edit that follows cannot be undone by a later scan.
 *
 * Idempotent, so every operation can front it without checking. Ungrouped is not
 * written: it is the absence of membership, and it re-derives for free.
 */
export function materialize(
  state: RailState,
  workflows: readonly WorkflowInfo[],
  edges: readonly LaunchEdge[],
  sort: RailSort = "recent",
): MaterializedRailState {
  if (isMaterialized(state)) return state;
  return {
    ...state,
    groups: buildGroupTree(workflows, edges, sort)
      .filter((group) => !group.isUngrouped)
      .map((group) => ({
        id: group.id,
        label: group.label,
        members: group.agents.map((agent) => agent.workflow.path),
      })),
  };
}

/**
 * Hands authority back to detection: the one operation that runs `materialize`
 * backwards.
 *
 * Materializing is a one-way door by design — "the user deleted every group"
 * must not be re-read as "detect again", or a reload would undo the deletion.
 * But that door left no way out. Materialize with nothing useful in it and every
 * agent falls to Ungrouped; the rail then looks broken and no amount of editing
 * gets detection back, because every edit works on the stored set that IS the
 * problem. This is the way out, and it has to be ASKED for: automatic recovery
 * would need a rule for when an arrangement is "bad enough" to discard, and any
 * such rule eventually throws away someone's deliberate choice — a single group
 * holding two agents is indistinguishable from a mess.
 *
 * Renames survive: they are names for AGENTS, not for groups, and nothing about
 * regrouping makes a name someone chose wrong.
 *
 * Safe on an already-derived state (returns it unchanged), so it can be wired to
 * a command or a shortcut without a guard.
 */
export const resetToDetected = (state: RailState): RailState =>
  isMaterialized(state) ? { ...state, groups: null } : state;

/**
 * Whether the UI should offer the reset at all. False on a state that is already
 * derived, where the control would be a button that does nothing — and a control
 * that does nothing reads as a broken one.
 *
 * True whenever groups are stored, INCLUDING when they hold real work: the trap
 * is not the empty case, it is being stuck with any arrangement you cannot get
 * out of, and a reset that only appears once you have deleted everything would
 * ask people to destroy their groups to find the way back. The cost belongs in
 * the confirmation copy, not in hiding the control — `state.groups.length` tells
 * the UI how much is at stake.
 */
export const canResetToDetected = (state: RailState): boolean => isMaterialized(state);

// ---------------------------------------------------------------------------
// Operations — pure: state in, new state out, nothing mutated
// ---------------------------------------------------------------------------

/**
 * Ids are derived from the label rather than randomized so a test can name the
 * group it just made, and so two studios that create the same group by hand land
 * on the same id instead of two rows saying one thing.
 */
function nextGroupId(groups: readonly StoredGroup[], label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "group";
  const taken = new Set(groups.map((group) => group.id));
  let id = `g_${slug}`;
  for (let n = 2; taken.has(id); n++) id = `g_${slug}-${n}`;
  return id;
}

/** The new group is appended LAST, so a caller that needs its id reads
 *  `next.groups[next.groups.length - 1].id`. */
export function createGroup(
  state: MaterializedRailState,
  label: string,
  members: readonly string[] = [],
): MaterializedRailState {
  const trimmed = label.trim();
  // A nameless group is an unreadable row; refusing beats storing one.
  if (trimmed === "") return state;
  return {
    ...state,
    groups: [
      ...state.groups,
      { id: nextGroupId(state.groups, trimmed), label: trimmed, members: dedupe(members) },
    ],
  };
}

export function renameGroup(
  state: MaterializedRailState,
  id: string,
  label: string,
): MaterializedRailState {
  const trimmed = label.trim();
  if (trimmed === "") return state;
  return {
    ...state,
    groups: state.groups.map((group) => (group.id === id ? { ...group, label: trimmed } : group)),
  };
}

/** Deletes the LABEL, not the agents. Its members fall to Ungrouped unless
 *  another group already claims them. */
export const deleteGroup = (state: MaterializedRailState, id: string): MaterializedRailState => ({
  ...state,
  groups: state.groups.filter((group) => group.id !== id),
});

/**
 * Adding an agent already in the group is a NO-OP, not an error: the gesture
 * that causes it is dropping an agent back where it already is, and answering
 * that with a warning — or with a second identical row — would both be wrong.
 */
export function addMember(
  state: MaterializedRailState,
  id: string,
  path: string,
): MaterializedRailState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === id && !group.members.includes(path)
        ? { ...group, members: [...group.members, path] }
        : group,
    ),
  };
}

export function removeMember(
  state: MaterializedRailState,
  id: string,
  path: string,
): MaterializedRailState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === id
        ? { ...group, members: group.members.filter((member) => member !== path) }
        : group,
    ),
  };
}

/** An agent leaves EVERY group — what a drop on `Ungrouped` means, because "no
 *  membership" is exactly what that section is. */
export const removeFromAllGroups = (
  state: MaterializedRailState,
  path: string,
): MaterializedRailState => ({
  ...state,
  groups: state.groups.map((group) =>
    group.members.includes(path)
      ? { ...group, members: group.members.filter((member) => member !== path) }
      : group,
  ),
});

/**
 * Copy across groups, keeping the original membership — the case the axis exists
 * for. A shared subagent is genuinely part of every system that calls it, and a
 * copy that moved it would make one of those systems lie.
 *
 * The source must still hold the path, so a stale drag cannot re-add an agent
 * the user has since removed. Copying into the source group is therefore the
 * same no-op as `addMember`.
 */
export function copyMemberToGroup(
  state: MaterializedRailState,
  fromId: string,
  toId: string,
  path: string,
): MaterializedRailState {
  const source = state.groups.find((group) => group.id === fromId);
  if (!source || !source.members.includes(path)) return state;
  return addMember(state, toId, path);
}

/**
 * One drop, resolved.
 *
 * Default is MOVE: leave the source group, join the target. Option-drag COPIES,
 * which is the shared-subagent case. A drop on `Ungrouped` removes the agent
 * from every group. A drop where it already is changes nothing.
 *
 * Nothing here touches the filesystem, and nothing should: on this axis a drag
 * rearranges MEANING. A "move" that also moved the directory would make the
 * Group axis assert a location it has no business asserting — that is the
 * Project axis's job, where the tree is derived from real paths.
 */
export function applyGroupDrop(
  state: MaterializedRailState,
  drop: { path: string; fromGroupId: string; toGroupId: string; copy: boolean },
): MaterializedRailState {
  const { path, fromGroupId, toGroupId, copy } = drop;
  if (path === "" || fromGroupId === toGroupId) return state;
  if (toGroupId === UNGROUPED_ID) {
    // Already unclaimed: dropping Ungrouped onto Ungrouped is a no-op, and
    // dropping a MEMBER there is how it leaves every group at once — not just
    // the one row it was dragged from, which would leave it grouped elsewhere
    // while sitting in the bucket that means "nothing claims this".
    return fromGroupId === UNGROUPED_ID ? state : removeFromAllGroups(state, path);
  }
  const joined = addMember(state, toGroupId, path);
  // Coming FROM Ungrouped there is no membership to give up, and a copy is by
  // definition "join without leaving".
  return copy || fromGroupId === UNGROUPED_ID ? joined : removeMember(joined, fromGroupId, path);
}
