/**
 * Pure command-palette model: which rows exist, what they say, and how a
 * query ranks them. No React, no fetch — CommandPalette.tsx renders this.
 *
 * The load-bearing choices (each one undoes a reported search failure):
 *   - Rows carry DISPLAY names (displayAgentName / sessionDisplayName), so
 *     what's searchable is what the rail shows, and user renames are findable.
 *   - Near-identical past sessions (same visible title, same folder) collapse
 *     to the newest — the history fan-out otherwise floods the list.
 *   - When querying, sections are ordered by their best hit instead of a
 *     fixed order, so an agent whose NAME matches is never buried under a
 *     pile of path-matched sessions; per-section caps keep every matching
 *     kind reachable, and they lift when only one kind matched at all.
 *   - Recency is a bounded score bonus: the thing you touched an hour ago
 *     outranks a stale row of comparable match quality, but a path-only
 *     match can never climb above a name match.
 *
 * The finder's surface (per the Command Search design): a filter-tab row
 * scopes the search to Templates / Docs / Files / Actions, app verbs arrive
 * as injected PaletteActions rather than hard-coded rows, and a short list
 * of documentation pages is searchable in place.
 */
import type { HarnessSession, SessionSummary, WorkflowInfo } from "@shared/types";

import { displayAgentName } from "./agent-name";
import type { FsDirEntry } from "./api";
import { DOC_LINKS, DOCS_SITE } from "./docs";
import { fuzzyMatch } from "./fuzzy";
// Separator-aware basename: a Windows path ("C:\\a\\b") must yield "b", not the
// whole string. One implementation, shared with the rest of the SPA.
import { basenameOf } from "./paths";
import { sessionDisplayName, type SessionNameOverrides } from "./session-name";
import { isUnder } from "./workspace-tree";

export type PaletteKind = "command" | "session" | "past" | "agent" | "recent" | "path" | "doc" | "template";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  /** Display name — matching runs on this exact string, so the highlight
   *  indices align with what's rendered. */
  label: string;
  /** Display meta: the raw path for jump targets (rendered monospace), a
   *  one-line description for actions and docs. */
  meta: string;
  /** Per-item icon override (actions carry their own); falls back to the
   *  kind's icon. */
  icon?: string;
  /** The injected verb an action row executes. */
  run?: () => void;
  /** External page a doc row opens. */
  href?: string;
  /** Gallery/starter id a template row opens in the templates browser. */
  templateId?: string;
  sessionId?: string;
  summary?: SessionSummary;
  /** The session the user is looking at right now — badged in the list, and
   *  never the default selection (jumping to it is a no-op). */
  current?: boolean;
  /** RAW absolute path for activation. */
  path?: string;
  /** Epoch ms, or a small MRU pseudo-recency (always below any timestamp,
   *  and too old for a recency bonus), or 0 for "no signal". */
  recency: number;
  labelIndices?: number[];
  metaIndices?: number[];
}

/** An app verb the palette can run. Supplied by the caller rather than
 *  hard-coded here: the palette knows how to FIND things, the app knows
 *  what it can do. */
export interface PaletteAction {
  id: string;
  label: string;
  meta?: string;
  icon?: string;
  run: () => void;
}

export type PaletteFilter = "all" | "sessions" | "agents" | "templates" | "docs" | "files" | "actions";

export const PALETTE_FILTERS: { id: PaletteFilter; label: string; icon: string }[] = [
  { id: "all", label: "All", icon: "Search" },
  { id: "sessions", label: "Sessions", icon: "Radio" },
  { id: "agents", label: "Agents", icon: "Workflow" },
  { id: "templates", label: "Templates", icon: "LayoutTemplate" },
  { id: "docs", label: "Docs", icon: "BookOpen" },
  { id: "files", label: "Files", icon: "Folder" },
  { id: "actions", label: "Actions", icon: "Zap" },
];

/** Where a tab continues, if it continues anywhere — the footer's CTA.
 *  `href` opens an external page; `actionId` runs one of the injected verbs. */
export const FILTER_DESTINATION: Partial<
  Record<PaletteFilter, { label: string; href?: string; actionId?: string }>
> = {
  templates: { label: "Browse templates", actionId: "browse-templates" },
  docs: { label: "Open documentation", href: DOCS_SITE },
};

/** A catalog entry the Templates tab lists — the minimal slice of a gallery
 *  or bundled-starter template the finder needs. */
export interface PaletteTemplate {
  id: string;
  name: string;
  description: string;
}

export interface PaletteSources {
  sessions: HarnessSession[];
  workflows: WorkflowInfo[];
  history: SessionSummary[];
  recentDirs: string[];
  /** User renames from ui-prefs — the palette must search the same names
   *  the rail and header render. */
  sessionNames: SessionNameOverrides;
  /** App verbs, in the order the Actions tab lists them. */
  actions: PaletteAction[];
  /** Template catalog (gallery + bundled starters), in gallery order. */
  templates: PaletteTemplate[];
  /** The session currently on screen — its row is badged and demoted. */
  activeSessionId?: string | null;
}

/** How many past sessions the empty-query list shows — the full history
 *  stays reachable by typing; unqueried it would otherwise drown the rest. */
export const PAST_UNQUERIED_CAP = 6;
/** Per-section cap while querying: one prolific kind (usually past sessions)
 *  must not starve the others out of the global window. Lifted when only a
 *  single section matched — there is nothing left to starve. */
export const SECTION_QUERIED_CAP = 6;
export const GLOBAL_CAP = 20;
const AGENTS_UNQUERIED_CAP = 6;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Bounded bonus so fresh rows outrank stale rows of comparable match
 *  quality. Tiers, not a curve, so ranking stays explainable; pseudo-recency
 *  values (tiny numbers) age out to 0 by construction. */
export function recencyBonus(now: number, recency: number): number {
  if (recency <= 0) return 0;
  const age = now - recency;
  if (age <= HOUR) return 30;
  if (age <= DAY) return 20;
  if (age <= 7 * DAY) return 12;
  if (age <= 30 * DAY) return 6;
  return 0;
}

const parseTime = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

interface PastCandidate {
  item: PaletteItem;
  cwd: string;
  /** Turn/message count — the better-kept row between two transcripts. */
  count: number;
  fromRegistry: boolean;
}

const keepsOver = (a: PastCandidate, b: PastCandidate): boolean => {
  if (a.item.recency !== b.item.recency) return a.item.recency > b.item.recency;
  // Registry rows resolve to a directly selectable session; on a dead-even
  // tie the resumable row must win, or Enter silently downgrades from
  // "switch to session" to "open review pane".
  if (a.fromRegistry !== b.fromRegistry) return a.fromRegistry;
  return a.count > b.count;
};

/**
 * Builds the display-ready rows: registry-mirror filtering, past-session
 * dedup, display names, recency, injected actions, doc links. No query
 * involved — rankPaletteItems does the matching.
 */
export function buildPaletteItems(src: PaletteSources): PaletteItem[] {
  const { sessions, workflows, history, recentDirs, sessionNames, actions, templates, activeSessionId } = src;

  const sessionItems: PaletteItem[] = sessions
    .filter((session) => session.status !== "exited")
    .map((session) => ({
      id: `session:${session.id}`,
      kind: "session" as const,
      label: sessionDisplayName(session, sessions, sessionNames),
      meta: session.cwd,
      sessionId: session.id,
      current: session.id === activeSessionId || undefined,
      recency: parseTime(session.lastActiveAt),
    }));

  // Past sessions: exited registry sessions plus history entries, minus the
  // history rows the registry already mirrors (same filter the rail uses).
  const registryIds = new Set(sessions.map((session) => session.id));
  const registryAgentIds = new Set(
    sessions.map((session) => session.agentSessionId).filter((id): id is string => id != null),
  );
  const pastCandidates: PastCandidate[] = [
    ...sessions
      .filter((session) => session.status === "exited")
      .map((session) => ({
        item: {
          id: `past:${session.id}`,
          kind: "past" as const,
          label: sessionDisplayName(session, sessions, sessionNames),
          meta: session.cwd,
          sessionId: session.id,
          recency: parseTime(session.lastActiveAt),
        },
        cwd: session.cwd,
        count: 0,
        fromRegistry: true,
      })),
    ...history
      .filter(
        (summary) =>
          !(summary.harnessSessionId != null && registryIds.has(summary.harnessSessionId)) &&
          !registryAgentIds.has(summary.agentSessionId),
      )
      .map((summary) => ({
        item: {
          id: `summary:${summary.agentSessionId}`,
          kind: "past" as const,
          label: sessionNames[summary.harnessSessionId ?? ""]?.trim() || summary.title,
          meta: summary.cwd,
          summary,
          recency: parseTime(summary.lastActiveAt),
        },
        cwd: summary.cwd,
        count: summary.turnCount ?? summary.messageCount ?? 0,
        fromRegistry: false,
      })),
  ];
  // Collapse rows the user cannot tell apart (same visible title in the same
  // folder) to the newest — the specific ones stay reachable via the rail's
  // history popover, which this dedup deliberately does not touch.
  const byTitleAndCwd = new Map<string, PastCandidate>();
  for (const candidate of pastCandidates) {
    const key = `${candidate.item.label.trim()}\u0000${candidate.cwd}`;
    const kept = byTitleAndCwd.get(key);
    if (!kept || keepsOver(candidate, kept)) byTitleAndCwd.set(key, candidate);
  }
  const pastItems = [...byTitleAndCwd.values()]
    .map((candidate) => candidate.item)
    .sort((a, b) => b.recency - a.recency);

  // WorkflowInfo has no timestamp — derive agent recency from the sessions
  // working in/on it, falling back to a small recentDirs MRU rank (orders
  // agents among themselves but never earns a recency bonus).
  const agentRecency = (workflow: WorkflowInfo): number => {
    let latest = 0;
    for (const session of sessions) {
      if (session.boundWorkflowPath !== workflow.path && !isUnder(session.cwd, workflow.path)) continue;
      const at = parseTime(session.lastActiveAt);
      if (at > latest) latest = at;
    }
    if (latest > 0) return latest;
    const mru = recentDirs.findIndex((dir) => isUnder(workflow.path, dir) || isUnder(dir, workflow.path));
    return mru === -1 ? 0 : recentDirs.length - mru;
  };
  const agentItems: PaletteItem[] = workflows.map((workflow) => ({
    id: `agent:${workflow.path}`,
    kind: "agent" as const,
    label: displayAgentName(workflow.name),
    meta: workflow.path,
    path: workflow.path,
    recency: agentRecency(workflow),
  }));

  const agentPaths = new Set(workflows.map((workflow) => workflow.path));
  const recentItems: PaletteItem[] = recentDirs
    .filter((dir) => !agentPaths.has(dir))
    .map((dir) => ({
      id: `recent:${dir}`,
      kind: "recent" as const,
      label: basenameOf(dir),
      meta: dir,
      path: dir,
      recency: recentDirs.length - recentDirs.indexOf(dir),
    }));

  const commandItems: PaletteItem[] = actions.map((action) => ({
    id: `command:${action.id}`,
    kind: "command" as const,
    label: action.label,
    meta: action.meta ?? "",
    icon: action.icon,
    run: action.run,
    recency: 0,
  }));

  const docItems: PaletteItem[] = DOC_LINKS.map((doc) => ({
    id: `doc:${doc.href}`,
    kind: "doc" as const,
    label: doc.label,
    meta: doc.meta,
    href: doc.href,
    recency: 0,
  }));

  const templateItems: PaletteItem[] = templates.map((template) => ({
    id: `template:${template.id}`,
    kind: "template" as const,
    label: template.name,
    meta: template.description,
    templateId: template.id,
    recency: 0,
  }));

  return [
    ...sessionItems,
    ...pastItems,
    ...agentItems,
    ...recentItems,
    ...templateItems,
    ...docItems,
    ...commandItems,
  ];
}

interface ScoredItem {
  item: PaletteItem;
  /** 0 = the visible name matched, 1 = only the meta did. Sorts before any
   *  score, so a meta-only hit can never float above a name hit. */
  fieldRank: number;
  /** Match score + recency bonus. */
  boosted: number;
  matchedLength: number;
}

/** Tie order between sections whose best hits are equal — deliberately puts
 *  Agents above Past sessions: agents are the durable things users reach
 *  for; history is the long tail. */
const SECTION_PRIORITY: Record<PaletteKind, number> = {
  session: 0,
  agent: 1,
  past: 2,
  recent: 3,
  template: 4,
  doc: 5,
  command: 6,
  path: 7,
};

/** Which kinds each filter tab searches. */
const FILTER_KINDS: Record<PaletteFilter, PaletteKind[]> = {
  all: ["session", "agent", "past", "recent", "template", "doc", "command"],
  sessions: ["session", "past"],
  agents: ["agent"],
  templates: ["template"],
  docs: ["doc"],
  files: ["recent"],
  actions: ["command"],
};

const byKind = (items: PaletteItem[], kind: PaletteKind): PaletteItem[] =>
  items.filter((item) => item.kind === kind);

/** Unqueried order within one kind: activity groups sort newest-first, the
 *  rest keep their build order (MRU for folders, list order for templates,
 *  docs, and actions). The CURRENT session sorts last among the live ones —
 *  it is always the most recently active, but jumping to it is a no-op, so
 *  it must never be the default-selected first row. */
function unqueriedGroup(items: PaletteItem[], kind: PaletteKind): PaletteItem[] {
  const group = byKind(items, kind);
  if (kind === "session") {
    return group.sort(
      (a, b) => (a.current ? 1 : 0) - (b.current ? 1 : 0) || b.recency - a.recency,
    );
  }
  if (kind === "past") return group.sort((a, b) => b.recency - a.recency);
  if (kind === "agent") return group.sort((a, b) => b.recency - a.recency || a.label.localeCompare(b.label));
  if (kind === "recent") return group.sort((a, b) => b.recency - a.recency);
  return group;
}

export interface RankOptions {
  filter?: PaletteFilter;
  /** Injectable clock so recency ranking is deterministic under test. */
  now?: number;
}

/**
 * "" → the unqueried composition (fixed section order, recency-sorted
 * groups, actions pinned last on the All tab). Otherwise: match both fields
 * (label preferred), band label over meta, add the recency bonus, rank
 * within sections, order sections by their best hit, cap per section and
 * globally.
 */
export function rankPaletteItems(query: string, items: PaletteItem[], options: RankOptions = {}): PaletteItem[] {
  const filter = options.filter ?? "all";
  const now = options.now ?? Date.now();
  const kinds = FILTER_KINDS[filter];
  const trimmed = query.trim();

  if (!trimmed) {
    if (filter !== "all") {
      return kinds.flatMap((kind) => unqueriedGroup(items, kind)).slice(0, GLOBAL_CAP);
    }
    const commandItems = byKind(items, "command");
    // Jump targets first; templates and docs fill leftover space; actions are
    // pinned at the end so the Actions section is always reachable without
    // typing.
    return [
      ...unqueriedGroup(items, "session"),
      ...unqueriedGroup(items, "past").slice(0, PAST_UNQUERIED_CAP),
      ...unqueriedGroup(items, "agent").slice(0, AGENTS_UNQUERIED_CAP),
      ...unqueriedGroup(items, "recent"),
      ...unqueriedGroup(items, "template"),
      ...unqueriedGroup(items, "doc"),
    ]
      .slice(0, Math.max(0, GLOBAL_CAP - commandItems.length))
      .concat(commandItems);
  }

  const scoreItem = (item: PaletteItem): ScoredItem | null => {
    const label = fuzzyMatch(trimmed, item.label);
    if (label) {
      return {
        item: { ...item, labelIndices: label.indices },
        fieldRank: 0,
        boosted: label.score + recencyBonus(now, item.recency),
        matchedLength: item.label.length,
      };
    }
    const meta = item.meta ? fuzzyMatch(trimmed, item.meta) : null;
    if (meta) {
      return {
        item: { ...item, metaIndices: meta.indices },
        fieldRank: 1,
        boosted: meta.score + recencyBonus(now, item.recency),
        matchedLength: item.meta.length,
      };
    }
    return null;
  };

  const sections = kinds
    .map((kind) => ({
      kind,
      scored: byKind(items, kind)
        .map(scoreItem)
        .filter((scored): scored is ScoredItem => scored !== null)
        .sort(
          (a, b) =>
            a.fieldRank - b.fieldRank ||
            b.boosted - a.boosted ||
            b.item.recency - a.item.recency ||
            a.matchedLength - b.matchedLength ||
            a.item.label.localeCompare(b.item.label),
        ),
    }))
    .filter((section) => section.scored.length > 0);

  // The per-section cap exists so no kind can starve the others; with a lone
  // matching section there is nothing to starve, so the window is its own cap.
  const sectionCap = sections.length > 1 ? SECTION_QUERIED_CAP : GLOBAL_CAP;

  return sections
    .sort((a, b) => {
      const bestA = a.scored[0];
      const bestB = b.scored[0];
      return (
        bestA.fieldRank - bestB.fieldRank ||
        bestB.boosted - bestA.boosted ||
        SECTION_PRIORITY[a.kind] - SECTION_PRIORITY[b.kind]
      );
    })
    .flatMap((section) => section.scored.slice(0, sectionCap).map((scored) => scored.item))
    .slice(0, GLOBAL_CAP);
}

/** Path-completion rows (query starts with / or ~): a confirm row for the
 *  literal input, then the listed directories. */
export function buildPathItems(query: string, dirs: FsDirEntry[]): PaletteItem[] {
  const trimmed = query.trim();
  const confirmItem: PaletteItem[] = trimmed
    ? [{ id: `confirm:${trimmed}`, kind: "path", label: trimmed, meta: "Open this path", path: trimmed, recency: 0 }]
    : [];
  return [
    ...confirmItem,
    ...dirs.map((dir) => ({
      id: `dir:${dir.path}`,
      kind: "path" as const,
      label: dir.name,
      meta: dir.path,
      path: dir.path,
      recency: 0,
    })),
  ];
}

export type PaletteActivation =
  | { type: "run"; run: () => void }
  | { type: "open-href"; href: string }
  | { type: "open-template"; templateId: string }
  | { type: "select-session"; sessionId: string }
  | { type: "review-summary"; summary: SessionSummary }
  | { type: "open-path"; path: string }
  | { type: "none" };

/** What activating a row does. A past row resolves its live/registry id
 *  first, then falls back to the transcript summary (review pane) — and
 *  never to open-path, so a stray `path` can't silently spawn a session. */
export function paletteActivation(item: PaletteItem): PaletteActivation {
  switch (item.kind) {
    case "command":
      return item.run ? { type: "run", run: item.run } : { type: "none" };
    case "doc":
      return item.href ? { type: "open-href", href: item.href } : { type: "none" };
    case "template":
      return item.templateId ? { type: "open-template", templateId: item.templateId } : { type: "none" };
    case "session":
      return item.sessionId ? { type: "select-session", sessionId: item.sessionId } : { type: "none" };
    case "past":
      if (item.sessionId) return { type: "select-session", sessionId: item.sessionId };
      if (item.summary) return { type: "review-summary", summary: item.summary };
      return { type: "none" };
    case "agent":
    case "recent":
    case "path":
      return item.path ? { type: "open-path", path: item.path } : { type: "none" };
  }
}
