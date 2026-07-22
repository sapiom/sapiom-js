import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import type { HarnessSession, SessionSummary, WorkflowInfo } from "@shared/types";

import type { FsDirEntry, FsListResponse } from "../lib/api";
import { fuzzyMatch } from "../lib/fuzzy";
import { Icon } from "./Icon";

interface PaletteItem {
  id: string;
  kind: "command" | "session" | "past" | "workflow" | "recent" | "path";
  label: string;
  meta: string;
  sessionId?: string;
  summary?: SessionSummary;
  path?: string;
  /** Matched character positions — set on the field the query hit. */
  labelIndices?: number[];
  metaIndices?: number[];
}

interface CommandPaletteProps {
  sessions: HarnessSession[];
  workflows: WorkflowInfo[];
  recentDirs: string[];
  /** Past sessions from the transcript/registry history fan-out —
   *  loaded by the opener, so the palette can jump to any past session too. */
  history: SessionSummary[];
  listDir: (path?: string) => Promise<FsListResponse>;
  onSelectSession: (id: string) => void;
  /** Opens the review pane for a transcript-only history entry (never
   *  silently spawns — resuming is the pane's explicit action). */
  onReviewSummary: (summary: SessionSummary) => void;
  onOpenPath: (cwd: string) => void;
  /** Opens the template gallery (browse -> preview -> use) — the palette is
   *  a first-class browse entry, not just the add dialog's branch. */
  onBrowseTemplates: () => void;
  onClose: () => void;
}

const ICON_FOR_KIND: Record<PaletteItem["kind"], string> = {
  command: "LayoutTemplate",
  session: "Radio",
  past: "History",
  workflow: "Workflow",
  recent: "Folder",
  path: "Folder",
};

/** Section headers keep mixed result types tellable apart: a session
 *  row and a folder row can share a name, so the group says which is which. */
const SECTION_LABELS: Record<PaletteItem["kind"], string> = {
  command: "Actions",
  session: "Sessions",
  past: "Past sessions",
  workflow: "Workflows",
  recent: "Folders",
  path: "Folders",
};

/** How many past sessions the empty-query list shows — the full history
 *  stays reachable by typing; unqueried it would otherwise drown the rest. */
const PAST_UNQUERIED_CAP = 6;

/** Wraps the characters at `indices` in <b> so the fuzzy hit is visible. */
function highlightText(text: string, indices: number[] | undefined): ReactNode {
  if (!indices || indices.length === 0) return text;
  const set = new Set(indices);
  const parts: ReactNode[] = [];
  let run = "";
  let runMatched = set.has(0);
  const flush = (key: number): void => {
    if (!run) return;
    parts.push(runMatched ? <b key={key} className="palette-match">{run}</b> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const matched = set.has(i);
    if (matched !== runMatched) {
      flush(i);
      runMatched = matched;
    }
    run += text[i];
  }
  flush(text.length);
  return parts;
}

/** Name matches outrank path matches: a query that hits the label scores in
 *  a band strictly above any meta-only hit, so "se" can never float a row
 *  whose visible name doesn't contain it over one whose name does. */
function scoreItem(query: string, item: PaletteItem): { item: PaletteItem; score: number } | null {
  const label = fuzzyMatch(query, item.label);
  if (label) return { item: { ...item, labelIndices: label.indices }, score: 1000 + label.score };
  const meta = fuzzyMatch(query, item.meta);
  if (meta) return { item: { ...item, metaIndices: meta.indices }, score: meta.score };
  return null;
}

/**
 * Cmd+K / Cmd+P quick-jump: fuzzy match over running sessions, past
 * sessions, workflow paths, and recent directories — grouped under section
 * headers with the matched characters bolded. When the query looks like a
 * path, GET /api/fs/list drives live directory completion instead. Enter
 * switches to a session hit, opens a past session for review, or starts a
 * fresh session at a path hit.
 */
export function CommandPalette({
  sessions,
  workflows,
  recentDirs,
  history,
  listDir,
  onSelectSession,
  onReviewSummary,
  onOpenPath,
  onBrowseTemplates,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [pathDirs, setPathDirs] = useState<FsDirEntry[]>([]);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const looksLikePath = query.startsWith("/") || query.startsWith("~");

  useEffect(() => {
    if (!looksLikePath) {
      setPathDirs([]);
      setPathError(false);
      return;
    }
    let cancelled = false;
    setPathLoading(true);
    setPathError(false);
    const handle = setTimeout(() => {
      listDir(query)
        .then((res) => {
          if (!cancelled) setPathDirs(res.dirs);
        })
        .catch(() => {
          if (!cancelled) {
            setPathDirs([]);
            setPathError(true);
          }
        })
        .finally(() => !cancelled && setPathLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, looksLikePath, listDir]);

  const items = useMemo<PaletteItem[]>(() => {
    if (looksLikePath) {
      const trimmed = query.trim();
      const confirmItem: PaletteItem[] = trimmed
        ? [{ id: `confirm:${trimmed}`, kind: "path", label: trimmed, meta: "Open this path", path: trimmed }]
        : [];
      const dirItems: PaletteItem[] = pathDirs.map((dir) => ({
        id: `dir:${dir.path}`,
        kind: "path",
        label: dir.name,
        meta: dir.path,
        path: dir.path,
      }));
      return [...confirmItem, ...dirItems];
    }

    const sessionItems: PaletteItem[] = sessions
      .filter((session) => session.status !== "exited")
      .map((session) => ({
        id: `session:${session.id}`,
        kind: "session",
        label: session.title,
        meta: session.cwd,
        sessionId: session.id,
      }));

    // Past sessions (the palette source): exited registry sessions
    // plus history entries — deduped the same way the rail's list is, so a
    // registry-mirrored transcript never renders twice.
    const registryIds = new Set(sessions.map((session) => session.id));
    const registryAgentIds = new Set(
      sessions.map((session) => session.agentSessionId).filter((id): id is string => id != null),
    );
    const pastItems: PaletteItem[] = [
      ...sessions
        .filter((session) => session.status === "exited")
        .map((session) => ({
          id: `past:${session.id}`,
          kind: "past" as const,
          label: session.title,
          meta: session.cwd,
          sessionId: session.id,
        })),
      ...history
        .filter(
          (summary) =>
            !(summary.harnessSessionId != null && registryIds.has(summary.harnessSessionId)) &&
            !registryAgentIds.has(summary.agentSessionId),
        )
        .map((summary) => ({
          id: `summary:${summary.agentSessionId}`,
          kind: "past" as const,
          label: summary.title,
          meta: summary.cwd,
          summary,
        })),
    ];

    const workflowItems: PaletteItem[] = workflows.map((workflow) => ({
      id: `workflow:${workflow.path}`,
      kind: "workflow",
      label: workflow.name,
      meta: workflow.path,
      path: workflow.path,
    }));

    // Palette actions: template browsing is reachable from anywhere, not
    // only the add dialog's "I don't have a project yet" branch.
    const commandItems: PaletteItem[] = [
      {
        id: "command:browse-templates",
        kind: "command",
        label: "Browse templates",
        meta: "Gallery and starters",
      },
    ];

    const workflowPaths = new Set(workflows.map((workflow) => workflow.path));
    const recentItems: PaletteItem[] = recentDirs
      .filter((dir) => !workflowPaths.has(dir))
      .map((dir) => ({
        id: `recent:${dir}`,
        kind: "recent",
        label: dir.split("/").filter(Boolean).pop() ?? dir,
        meta: dir,
        path: dir,
      }));

    if (!query) {
      // Actions ride below the jump targets but are never crowded out of
      // the unqueried list — the cap applies to the target rows only.
      return [...sessionItems, ...pastItems.slice(0, PAST_UNQUERIED_CAP), ...workflowItems, ...recentItems]
        .slice(0, 20 - commandItems.length)
        .concat(commandItems);
    }

    // Filter and rank WITHIN each section, then keep the fixed section order:
    // grouping is what makes two same-named rows of different types readable,
    // so scores never interleave the groups.
    return [sessionItems, pastItems, workflowItems, recentItems, commandItems]
      .flatMap((section) =>
        section
          .map((item) => scoreItem(query, item))
          .filter((entry): entry is { item: PaletteItem; score: number } => entry !== null)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.item),
      )
      .slice(0, 20);
  }, [query, looksLikePath, pathDirs, sessions, workflows, recentDirs, history]);

  useEffect(() => setSelectedIndex(0), [items.length, query]);

  const activate = (item: PaletteItem): void => {
    if (item.kind === "command") {
      onBrowseTemplates();
    } else if ((item.kind === "session" || item.kind === "past") && item.sessionId) {
      onSelectSession(item.sessionId);
    } else if (item.kind === "past" && item.summary) {
      onReviewSummary(item.summary);
    } else if (item.path) {
      onOpenPath(item.path);
    }
    onClose();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIndex];
      if (item) activate(item);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          data-testid="command-palette-input"
          placeholder="Jump to a session, workflow, or path…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-list" data-testid="command-palette-list">
          {looksLikePath && pathLoading && <div className="command-palette-empty">Loading…</div>}
          {looksLikePath && pathError && !pathLoading && (
            <div className="command-palette-error" data-testid="command-palette-error" role="alert">
              Couldn't read that path.
            </div>
          )}
          {items.length === 0 && !pathLoading && !pathError && <div className="command-palette-empty">No matches</div>}
          {items.map((item, index) => (
            <div key={item.id} className="command-palette-row">
              {/* Path mode is homogeneous (all folders) — headers only earn
                  their space when result types actually mix. */}
              {!looksLikePath && (index === 0 || SECTION_LABELS[item.kind] !== SECTION_LABELS[items[index - 1].kind]) && (
                <div className="command-palette-section" data-testid="command-palette-section">
                  {SECTION_LABELS[item.kind]}
                </div>
              )}
              <button
                type="button"
                className={"command-palette-item" + (index === selectedIndex ? " is-selected" : "")}
                data-testid={`command-palette-item-${index}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => activate(item)}
              >
                <Icon name={ICON_FOR_KIND[item.kind]} size={14} />
                <span className="command-palette-item-label">{highlightText(item.label, item.labelIndices)}</span>
                <span className="command-palette-item-meta">{highlightText(item.meta, item.metaIndices)}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
