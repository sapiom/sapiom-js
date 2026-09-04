import type { WorkflowInfo } from "@shared/types";
import type { RailSort } from "../../../src/shared/project-roots.js";

import { displayAgentName } from "./agent-name";
import {
  basenameOf,
  isWithinDir,
  joinPath,
  parentOf,
  stripTrailingSep,
} from "./paths";

/**
 * WHICH FOLDERS ARE PROJECTS now lives in `src/shared/project-roots`, because the
 * SERVER has to reach the same answer: it issues one durable Studio project
 * per workspace scope, and a scope list built from a second definition left
 * every promoted root without a project (see that module's header). Re-exported
 * here so this file stays the rail's one import for project shape.
 */
export type {
  ProjectRootSources,
  RailSort,
} from "../../../src/shared/project-roots.js";
export {
  holdingProjectFor,
  projectRoots,
  projectSessionRoot,
  projectToOpen,
} from "../../../src/shared/project-roots.js";

/**
 * The rail's filing axes.
 *
 * `project` is where an agent LIVES — a root folder the user opened, plus the
 * directory structure beneath it. It replaces `workspace | deployment`.
 *
 * `workspace` accumulated forever: any directory that had ever hosted a
 * session or been connected became a row, so a real install carried 40 rows
 * for 75 agents, 24 of them an agent's own directory and 15 of them one agent
 * wearing its own folder's name. A project is something the user CHOSE, so
 * nothing accumulates behind them.
 *
 * `deployment` bucketed `definitionId != null` — a fact every agent row
 * already prints as a cloud glyph — so it re-sorted the rail to tell you
 * nothing new. It is retired.
 *
 * `group` took its slot: what an agent is RELATED to, read off the launch edges
 * between agents, which say nothing about the disk. Its model and derivation
 * live in `agent-groups.ts` — nothing about a group is a path, so none of this
 * module's tree building applies to it. Any future axis must clear the same bar:
 * a fact the row cannot already show.
 */
export type RailAxis = "project" | "group";

/* `RailSort` is defined in `src/shared/project-roots` and re-exported above: it
   orders the PROJECT rows, which that module produces. `WorkflowInfo` has no
   timestamp, so agent rows stay path-stable whatever this is set to — "recent"
   changes project order, not row order. */

/**
 * One agent row. `prefix` is the unbranched directory chain compacted ONTO
 * this row — the `tools` of `scripts/tools/rollup` when nothing else lives
 * down that path. It is display context, never the row's identity: the row is
 * named for the agent, because the path is not what you are looking for most
 * of the time.
 */
export interface AgentNode {
  workflow: WorkflowInfo;
  /**
   * The IMMEDIATE PARENT directory only, never the abbreviated chain.
   *
   * A directory row owns its whole row, so `first/…/last` fits there. An agent
   * row shares its width with the agent's NAME, and at rail width a
   * multi-segment path loses that fight: rendering the chain produced
   * `harness/…… mail…` — the chain's own ellipsis plus a CSS one — and an
   * unreadable agent name. A flex shrink ratio cannot fix it either, because
   * flex shrinks in proportion to basis and the long path has the larger
   * basis. One segment always fits, says where the agent sits relative to its
   * neighbours, and the absolute path is in the row's title.
   */
  prefix: string;
  /** The same chain unabbreviated, for the tooltip and copy-path. */
  prefixFull: string;
}

/**
 * A directory row inside a project. Only ever exists where the tree actually
 * BRANCHES — a directory with one child and no agent of its own is compacted
 * into that child rather than spending a row to say nothing.
 */
export interface DirNode {
  /** Absolute path, in the root's native spelling. The stable identity for
   *  collapse state (namespaced by `dirKey`) and the row's `title`. */
  path: string;
  /** Compacted and, when it earns it, middle-elided: `packages/…/components`. */
  label: string;
  /** Compacted, unabbreviated, for the tooltip and testids. */
  labelFull: string;
  dirs: DirNode[];
  agents: AgentNode[];
}

/**
 * A project: the root folder the user opened. We expect most people to have
 * exactly one, holding several agent systems.
 */
export interface ProjectNode {
  /** Absolute root path, exactly as the settings/session record spells it. */
  root: string;
  /** Basename of the root, widened only where it would be ambiguous — see
   *  `projectLabeller`. */
  label: string;
  dirs: DirNode[];
  /** Agents reached directly from the root. Excludes `rootAgent`. */
  agents: AgentNode[];
  /**
   * The agent whose directory IS the project root, when there is one.
   *
   * Kept apart from `agents` because it must NOT get a row of its own: the
   * project row and that agent are the same directory, so rendering both
   * prints one word twice (`rfq-agent > rfq-agent`). That stutter was 15 of
   * one install's 40 rows. The renderer merges this into the project row,
   * which then carries the agent's selection and focus behaviour.
   *
   * Anything asking "is this project empty?" MUST consult this field —
   * `projectIsEmpty` is the one answer. A merged root-agent project has no
   * rows in `dirs` or `agents` at all, and a naive check renders its agent row
   * underneath an "No agents yet" empty state.
   */
  rootAgent: AgentNode | null;
}

/**
 * A compacted chain longer than this many segments is middle-elided. Two
 * segments always render in full — eliding them saves nothing and costs the
 * only context the row had.
 */
const MAX_SEGMENTS = 2;
/** Below this width the full chain is kept even when it exceeds MAX_SEGMENTS,
 *  so a short deep chain (`backend/src/agents`) stays whole. Elision is
 *  earned, not automatic. */
const ABBREVIATE_OVER_CHARS = 22;

/**
 * Containment, delegated to `paths.isWithinDir` so there is exactly ONE answer
 * to "is this path inside that root" in the app. Two implementations of this
 * drifted once already — one trimmed trailing slashes and the other did not —
 * which is the sort of disagreement that files an agent under one project
 * while its session boots in another.
 */
const isUnder = (childPath: string, root: string): boolean =>
  isWithinDir(root, childPath);

/** Comparison form: forward slashes, no trailing separator. Never rendered and
 *  never POSTed — what the server sent keeps its native spelling. */
const canonical = (p: string): string =>
  stripTrailingSep(p.replace(/\\/g, "/"));

/** The segments of `target` below `root`, empty when they are the same
 *  directory. Compares in canonical form so a trailing slash or a
 *  mixed-separator Windows path still lines up. */
function segmentsBetween(root: string, target: string): string[] {
  const r = canonical(root);
  const t = canonical(target);
  if (t === r) return [];
  const rest = r.endsWith("/") ? t.slice(r.length) : t.slice(r.length + 1);
  return rest.split("/").filter(Boolean);
}

/**
 * `first/…/last`, but only once eliding actually buys width. Abbreviating is
 * how a deep monorepo path stays a calm one-line row instead of the widest
 * thing in the rail; the full chain is one hover away and the row never
 * depended on it.
 */
export function abbreviate(segments: string[]): string {
  const full = segments.join("/");
  if (segments.length <= MAX_SEGMENTS || full.length <= ABBREVIATE_OVER_CHARS)
    return full;
  return `${segments[0]}/…/${segments[segments.length - 1]}`;
}

/**
 * COLLIDING LABELS GROW LEFTWARD — one rule, one implementation.
 *
 * `segments` is the path chain a row could show, deepest segment last; `others`
 * is the same chain for every row this one could be confused with. The answer
 * is the SHORTEST trailing run of `segments` that no entry in `others` shares.
 *
 * Only the colliding rows pay. Widening every label to be safe would spend the
 * rail's width disambiguating things that were never ambiguous, which is why
 * the loop starts at `min` and stops the moment the row is distinguishable.
 *
 * Two callers, deliberately: `projectLabeller` (two unrelated roots that happen
 * to share a basename) and `unrootedAgents` (six git worktrees holding one
 * agent name). They are the same question asked about different chains, and
 * round 1 shipped an unrooted section of six identical rows precisely because
 * the rule existed for one of them and not the other.
 *
 * Exhausting the chain returns it whole — there is nothing further left to
 * grow into, and a caller that has an absolute form to fall back on says so
 * itself.
 */
export function growLeftward(
  segments: readonly string[],
  others: readonly (readonly string[])[],
  min = 1,
): string[] {
  for (let take = Math.max(min, 1); take <= segments.length; take++) {
    const candidate = segments.slice(-take).join("/");
    if (!others.some((other) => other.slice(-take).join("/") === candidate)) {
      return segments.slice(-take);
    }
  }
  return [...segments];
}

/**
 * Does `prefix/name` spell a real path tail for this agent?
 *
 * THE ROW COMPOSES TWO DIFFERENT KINDS OF THING and joins them with a slash,
 * which asserts they are one path. That assertion is TRUE exactly when the
 * agent's own directory is named for the agent — `scripts/tools/rollup` holding
 * `rollup` renders `tools/rollup`, which is really there on disk.
 *
 * It is FALSE whenever they differ, and on the user's real install that was the
 * DOMINANT case: `ari-grade-repo` lives in `ari/orchestration`, so the row read
 * `ari/ari-grade-repo` — a location that does not exist, printed on the axis
 * whose entire job is being trustworthy about location. (The registry takes an
 * agent's name from its `package.json`, so name-vs-folder drift is normal, not
 * exotic.)
 *
 * The answer is not to widen the row into `ari/orchestration · ari-grade-repo`
 * — a rail cannot spend that width, and the prefix was always display context
 * rather than identity. It is to stop the SEPARATOR lying: a slash where the
 * join is a path, and a different mark where the row is saying two things.
 * Callers read this and pick the separator; nothing about the two spans, or
 * about [SEEN] rule 2 (the separator lives outside the truncating span),
 * changes.
 *
 * Compared against the DISPLAY name too, because that is what the row prints:
 * `@sapiom/example-slack-notifier` in a folder called `slack-notifier` is a
 * folder named for its agent as far as the reader is concerned.
 */
export function prefixIsPathTail(
  workflow: Pick<WorkflowInfo, "path" | "name">,
  displayName: string,
): boolean {
  const folder = basenameOf(canonical(workflow.path));
  return folder === workflow.name || folder === displayName;
}

/** The letter a project row falls back to when no mark was found inside it.
 *  Derived, never fetched: a remote avatar is an identicon as often as a logo,
 *  and a wrong logo is worse than an honest initial. */
export function projectInitial(root: string): string {
  return (basenameOf(root).match(/[A-Za-z0-9]/)?.[0] ?? "•").toUpperCase();
}

// Agent rows have no recency signal (WorkflowInfo carries no timestamp), so
// "recent" cannot order them — it falls back to a stable path sort. Only the
// project rows above them honor recency. See the RailSort doc.
const agentOrder =
  (sort: RailSort) =>
  (a: AgentNode, b: AgentNode): number =>
    sort === "name"
      ? // BY WHAT THE ROW SHOWS. `workflow.name` is the registry's raw name and
        // the row prints `displayAgentName` of it — so a rail full of
        // `@sapiom/example-*` agents sorted on a scope the user cannot see, and
        // "Sort by: Name" produced an order with no visible logic. A sort is a
        // claim about the list on screen.
        displayAgentName(a.workflow.name).localeCompare(
          displayAgentName(b.workflow.name),
        )
      : a.workflow.path.localeCompare(b.workflow.path);

/** A raw trie node, before compaction. */
interface TrieNode {
  name: string;
  path: string;
  agent: WorkflowInfo | null;
  children: Map<string, TrieNode>;
}

const newTrieNode = (name: string, path: string): TrieNode => ({
  name,
  path,
  agent: null,
  children: new Map(),
});

/**
 * Walks DOWN from `node` for as long as the path does not branch, collecting
 * the segments it passed through. Stops at an agent (an agent absorbs the
 * chain as its prefix) and at any node with more than one child — that is a
 * real branch and earns its own row.
 */
function collapse(node: TrieNode): { segments: string[]; node: TrieNode } {
  const segments = [node.name];
  let cursor = node;
  while (!cursor.agent && cursor.children.size === 1) {
    const [only] = cursor.children.values();
    segments.push(only.name);
    cursor = only;
  }
  return { segments, node: cursor };
}

/** Turns a compacted trie node into the rendered rows beneath it. */
function renderChildren(
  node: TrieNode,
  sort: RailSort,
): { dirs: DirNode[]; agents: AgentNode[] } {
  const dirs: DirNode[] = [];
  const agents: AgentNode[] = [];

  for (const child of node.children.values()) {
    const { segments, node: target } = collapse(child);

    if (target.agent) {
      // The chain above an agent is display context on the agent's own row.
      // The agent's own directory name is the last segment and the row is
      // named for the agent, so only what sits ABOVE it becomes the prefix.
      const prefixSegments = segments.slice(0, -1);
      const agentNode: AgentNode = {
        workflow: target.agent,
        prefix: prefixSegments[prefixSegments.length - 1] ?? "",
        prefixFull: prefixSegments.join("/"),
      };
      // An agent project that itself contains agents keeps its own subtree, so
      // it becomes a directory row holding its own row plus its children.
      const nested = renderChildren(target, sort);
      if (nested.dirs.length > 0 || nested.agents.length > 0) {
        dirs.push({
          path: target.path,
          label: abbreviate(segments),
          labelFull: segments.join("/"),
          dirs: nested.dirs,
          agents: [agentNode, ...nested.agents].sort(agentOrder(sort)),
        });
      } else {
        agents.push(agentNode);
      }
      continue;
    }

    const nested = renderChildren(target, sort);
    // A directory that leads to nothing is not a row. The trie only ever grows
    // along agent paths, so this is a guard, not a filter over a real tree.
    if (nested.dirs.length === 0 && nested.agents.length === 0) continue;
    dirs.push({
      path: target.path,
      label: abbreviate(segments),
      labelFull: segments.join("/"),
      dirs: nested.dirs,
      agents: nested.agents,
    });
  }

  dirs.sort((a, b) => a.labelFull.localeCompare(b.labelFull));
  agents.sort(agentOrder(sort));
  return { dirs, agents };
}

/**
 * PROJECT axis: root folder > (branching directories) > agents.
 *
 * An agent is filed under EVERY root that contains it, not just the deepest.
 * Opening both `~/polsia` and `~/polsia/backend/src/agents` gives two rows for
 * the same agent on purpose: they are two separate contexts, and a session
 * started in one has a different reach than a session started in the other.
 * The old single-owner rule (longest prefix wins) made the shallower project
 * silently lose agents it plainly contains.
 */
export function buildProjectTree(
  workflows: WorkflowInfo[],
  roots: readonly string[],
  sort: RailSort = "recent",
): ProjectNode[] {
  const label = projectLabeller(roots);
  return roots.map((root) => {
    const trieRoot = newTrieNode(basenameOf(root), root);

    for (const workflow of workflows) {
      if (!isUnder(workflow.path, root)) continue;
      const segments = segmentsBetween(root, workflow.path);
      if (segments.length === 0) {
        // The root folder is itself an agent project.
        trieRoot.agent = workflow;
        continue;
      }
      let cursor = trieRoot;
      let path = root;
      for (const segment of segments) {
        path = joinPath(path, segment);
        let next = cursor.children.get(segment);
        if (!next) {
          next = newTrieNode(segment, path);
          cursor.children.set(segment, next);
        }
        cursor = next;
      }
      cursor.agent = workflow;
    }

    const { dirs, agents } = renderChildren(trieRoot, sort);
    return {
      root,
      label: label(root),
      dirs,
      agents,
      rootAgent: trieRoot.agent
        ? { workflow: trieRoot.agent, prefix: "", prefixFull: "" }
        : null,
    };
  });
}

/**
 * The ONE answer to "does this project have any agent rows?".
 *
 * `rootAgent` is the trap: a merged root-agent project has nothing in `dirs`
 * or `agents`, so `dirs.length === 0 && agents.length === 0` reports it empty
 * and the rail renders its agent row under a "No agents yet" empty state.
 */
export function projectIsEmpty(project: ProjectNode): boolean {
  return (
    project.rootAgent === null &&
    project.dirs.length === 0 &&
    project.agents.length === 0
  );
}

/**
 * The prefix each agent row should show, for a set of agents rendered TOGETHER
 * outside the directory tree.
 *
 * `buildProjectTree` computes prefixes as a side effect of compaction, which
 * only works because that tree has directory rows to carry the context a prefix
 * leaves out. The Group axis has none — a group is a relationship, not a place —
 * so its rows are the whole answer to "which agent is this", and round 1 passed
 * them no prefix at all. Two agents named `ads` in one project rendered as two
 * identical rows inside `Ungrouped`, which is the same failure the unrooted
 * section had, one axis over.
 *
 * Same rule, therefore: the immediate parent by default ([SEEN] rule 1), grown
 * leftward only for the rows that actually collide. Relative to `root`, because
 * here there IS a root and repeating it on every row would spend the rail's
 * width saying what the section header already said.
 */
export function agentPrefixes(
  workflows: readonly WorkflowInfo[],
  root: string,
): Map<string, AgentNode> {
  const chains = workflows.map((workflow) =>
    segmentsBetween(root, workflow.path).slice(0, -1),
  );
  // COMPARE WHAT THE ROW PRINTS, not the registry's raw name. The row renders
  // `displayAgentName`, which strips an npm scope and a leading `example-` — so
  // keying the collision on `workflow.name` let `@sapiom/example-ads` and
  // `@acme/ads` past the check as "different names" and then drew them both as
  // a bare `ads`. Two identical rows, produced by the very function added to
  // prevent them.
  const shown = workflows.map((workflow) => displayAgentName(workflow.name));
  const out = new Map<string, AgentNode>();
  workflows.forEach((workflow, index) => {
    const others = workflows.flatMap((other, j) =>
      j !== index && shown[j] === shown[index] ? [chains[j]!] : [],
    );
    out.set(workflow.path, {
      workflow,
      prefix: growLeftward(chains[index]!, others).join("/"),
      prefixFull: chains[index]!.join("/"),
    });
  });
  return out;
}

/**
 * Agents no open root contains — rendered under a quiet header of their own,
 * still as agent rows.
 *
 * Rarer than the old "No workspace" bucket, because every `recentDirs` entry
 * and every session cwd becomes a project (there is no migration), but not
 * impossible: an agent registered from a folder that has since been removed
 * from the project list has nowhere else to go, and dropping it would hide an
 * agent that exists.
 */
export function unrootedAgents(
  workflows: WorkflowInfo[],
  roots: readonly string[],
  sort: RailSort = "recent",
): AgentNode[] {
  const outside = workflows.filter(
    (workflow) => !roots.some((root) => isUnder(workflow.path, root)),
  );
  // The chain ABOVE each agent's own directory, canonical, deepest segment
  // last. There is no project root to measure from here, so the chain is the
  // whole absolute parent — which is exactly why the growing has to be bounded
  // by collision rather than by depth.
  const chains = outside.map((workflow) =>
    canonical(workflow.path).split("/").filter(Boolean).slice(0, -1),
  );
  // Same rule as `agentPrefixes`: the comparison is on the DISPLAYED name,
  // because that is what the reader has to tell apart.
  const shown = outside.map((workflow) => displayAgentName(workflow.name));
  return outside
    .map((workflow, index) => {
      // TWO ROWS COLLIDE WHEN THEIR NAME AND THEIR PREFIX BOTH MATCH, so the
      // set this row has to be told apart from is the other rows wearing its
      // name — not every unrooted row. A real install had `ari-grade-repo` six
      // times across git worktrees; `filler-1` next to them was never ambiguous
      // and keeps its single parent segment.
      const others = outside.flatMap((other, j) =>
        j !== index && shown[j] === shown[index] ? [chains[j]!] : [],
      );
      return {
        workflow,
        prefix: growLeftward(chains[index]!, others).join("/"),
        // The ABSOLUTE parent directory, not a chain below some root: an
        // unrooted agent has no root, and half a path would be a worse answer
        // than none.
        prefixFull: parentOf(workflow.path) ?? "",
      };
    })
    .sort(agentOrder(sort));
}

/**
 * Project labels.
 *
 * Normally a project is just its folder's name — `polsia`, `acme-app`. Two
 * cases need more:
 *
 *  1. A project opened INSIDE another open project (supported on purpose:
 *     `~/polsia` and `~/polsia/services/workers` are two real contexts).
 *     Labelled by its path from the parent project — `polsia/services/workers`
 *     — so it reads as a place within something, and so it cannot be confused
 *     with the plain subdirectory row of the same name sitting inside that
 *     parent. That collision is the one a real rail actually hits, and a bare
 *     `workers` twice, two indent levels apart, is unreadable.
 *  2. Two unrelated roots that happen to share a basename. The label grows
 *     leftward a segment at a time until it is unique.
 *
 * Only the affected labels pay. Widening every project name to be safe would
 * spend the rail's width disambiguating things that were never ambiguous.
 */
function projectLabeller(roots: readonly string[]): (root: string) => string {
  const segmentsOf = (root: string): string[] =>
    canonical(root).split("/").filter(Boolean);
  const counts = new Map<string, number>();
  for (const root of roots) {
    const base = basenameOf(root);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  /** The deepest OTHER open project that contains this one. */
  const parentOf = (root: string): string | null => {
    let best: string | null = null;
    for (const other of roots) {
      if (canonical(other) === canonical(root) || !isUnder(root, other))
        continue;
      if (best === null || canonical(other).length > canonical(best).length)
        best = other;
    }
    return best;
  };
  return (root: string): string => {
    const parent = parentOf(root);
    /* NOT ELIDED, deliberately, and this is B2 left open rather than fixed.
       A project three levels inside another reads
       `harness/projects/cold-outreach-engine`, which is this rule working as
       specified and unreadable at that depth: 4 of the 5 clipped rows measured
       on a captured install were this label. `abbreviate` is the obvious fix
       and it was reverted, because the rail derives testids from the label
       (`workspace-group-${label}`, `project-row-`, `project-select-`,
       `project-disclosure-`), so shortening a label silently renames four
       testids and broke six specs. The label wants fixing WITH a stable row
       identity, not before one, and bundling that into this change would hide
       it inside a rename. Filed. */
    if (parent)
      return `${basenameOf(parent)}/${segmentsBetween(parent, root).join("/")}`;
    const base = basenameOf(root);
    if ((counts.get(base) ?? 0) < 2) return base;
    const segments = segmentsOf(root);
    // The SAME grow-leftward rule the unrooted rows use — see `growLeftward`.
    // `min` is 2 because reaching here already proved one segment collides.
    const others = roots
      .filter((other) => canonical(other) !== canonical(root))
      .map(segmentsOf);
    const grown = growLeftward(segments, others, 2);
    // Exhausted without ever becoming unique (two roots spelled the same in
    // different filesystem roots): the absolute path is the only honest answer
    // left, and unlike the joined segments it keeps its leading separator.
    if (
      grown.length === segments.length &&
      others.some((other) => other.join("/") === segments.join("/"))
    )
      return root;
    return grown.join("/");
  };
}
