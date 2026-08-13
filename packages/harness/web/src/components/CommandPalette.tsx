import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import type { HarnessSession, SessionSummary, TemplateListResponse, WorkflowInfo } from "@shared/types";

import type { FsDirEntry, FsListResponse } from "../lib/api";
import {
  buildPaletteItems,
  buildPathItems,
  FILTER_DESTINATION,
  PALETTE_FILTERS,
  paletteActivation,
  rankPaletteItems,
} from "../lib/palette";
import type { PaletteAction, PaletteFilter, PaletteItem, PaletteTemplate } from "../lib/palette";
import type { SessionNameOverrides } from "../lib/session-name";
import { STARTER_TEMPLATES } from "../lib/templates";
import { useTabIndicator } from "../lib/use-tab-indicator";
import { looksAbsolutePath } from "../lib/paths";
import { Icon } from "./Icon";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

interface CommandPaletteProps {
  sessions: HarnessSession[];
  workflows: WorkflowInfo[];
  recentDirs: string[];
  /** Past sessions from the transcript/registry history fan-out —
   *  loaded by the opener, so the palette can jump to any past session too. */
  history: SessionSummary[];
  /** User renames from ui-prefs — the palette searches and shows the same
   *  names the rail and header render. */
  sessionNames: SessionNameOverrides;
  /** The session on screen — badged "current", demoted from the top spot. */
  activeSessionId: string | null;
  /** App verbs the palette can run. Supplied by the caller rather than
   *  hard-coded here: the palette knows how to FIND things, the app knows
   *  what it can do, and threading one prop per verb would have grown a
   *  parameter for every button in the product. */
  actions: PaletteAction[];
  listDir: (path?: string) => Promise<FsListResponse>;
  /** Feeds the Templates tab (gallery + bundled starters). */
  listTemplates: () => Promise<TemplateListResponse>;
  onSelectSession: (id: string) => void;
  /** Opens the review pane for a transcript-only history entry (never
   *  silently spawns — resuming is the pane's explicit action). */
  onReviewSummary: (summary: SessionSummary) => void;
  onOpenPath: (cwd: string) => void;
  /** Opens the templates browser focused on one template. */
  onOpenTemplate: (templateId: string) => void;
  onClose: () => void;
}

const ICON_FOR_KIND: Record<PaletteItem["kind"], string> = {
  command: "Zap",
  doc: "BookOpen",
  session: "Radio",
  past: "History",
  agent: "Workflow",
  recent: "Folder",
  path: "Folder",
  template: "LayoutTemplate",
};

/** Section headers keep mixed result types tellable apart: a session
 *  row and a folder row can share a name, so the group says which is which. */
const SECTION_LABELS: Record<PaletteItem["kind"], string> = {
  command: "Actions",
  doc: "Documentation",
  session: "Sessions",
  past: "Past sessions",
  agent: "Agents",
  recent: "Folders",
  path: "Folders",
  template: "Templates",
};

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

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

/**
 * Cmd+K / Cmd+P quick-jump (the Command Search widget): a search bar, a
 * filter-tab row (All / Templates / Docs / Files / Actions), the ranked
 * result list, and a shortcut bar. Matching and ranking live in
 * lib/palette.ts (display-name matching, past-session dedup, best-hit
 * section order, recency boost). When the query looks like a path,
 * GET /api/fs/list drives live directory completion instead. Enter switches
 * to a session hit, opens a past session for review, runs an action, opens
 * a doc, or starts a fresh session at a path hit.
 */
export function CommandPalette({
  sessions,
  workflows,
  recentDirs,
  history,
  sessionNames,
  activeSessionId,
  actions,
  listDir,
  listTemplates,
  onSelectSession,
  onReviewSummary,
  onOpenPath,
  onOpenTemplate,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteFilter>("all");
  const [templates, setTemplates] = useState<PaletteTemplate[]>([]);
  const [pathDirs, setPathDirs] = useState<FsDirEntry[]>([]);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filterTabs = useTabIndicator(filter);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The catalog is small and cached server-side; one fetch per open keeps
  // the Templates tab live without a loading state — until it lands (or if
  // it fails), the bundled starters are still listed.
  useEffect(() => {
    let cancelled = false;
    setTemplates(STARTER_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })));
    listTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplates([
          ...res.templates.map(({ id, name, description }) => ({ id, name, description })),
          ...STARTER_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
        ]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [listTemplates]);

  // looksAbsolutePath, not a two-prefix check: a Windows user types "C:\\…",
  // which the SPA must recognize as a path (see lib/paths.ts).
  const looksLikePath = looksAbsolutePath(query);

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
    if (looksLikePath) return buildPathItems(query, pathDirs);
    return rankPaletteItems(
      query,
      buildPaletteItems({
        sessions,
        workflows,
        history,
        recentDirs,
        sessionNames,
        actions,
        templates,
        activeSessionId,
      }),
      { filter },
    );
  }, [
    query,
    looksLikePath,
    pathDirs,
    sessions,
    workflows,
    recentDirs,
    history,
    sessionNames,
    activeSessionId,
    actions,
    templates,
    filter,
  ]);

  useEffect(() => {
    // Default selection = the first ranked row that ISN'T the session the
    // user is already looking at (jumping there is a no-op).
    const first = items.findIndex((item) => !item.current);
    setSelectedIndex(first === -1 ? 0 : first);
  }, [items, query, filter]);

  // Where this tab continues, if it continues anywhere. Path mode has no
  // tabs, so it has no destination either.
  const destination = looksLikePath ? undefined : FILTER_DESTINATION[filter];

  const activate = (item: PaletteItem): void => {
    const activation = paletteActivation(item);
    switch (activation.type) {
      case "run":
        activation.run();
        break;
      case "open-href":
        window.open(activation.href, "_blank", "noopener,noreferrer");
        break;
      case "open-template":
        onOpenTemplate(activation.templateId);
        break;
      case "select-session":
        onSelectSession(activation.sessionId);
        break;
      case "review-summary":
        onReviewSummary(activation.summary);
        break;
      case "open-path":
        onOpenPath(activation.path);
        break;
      case "none":
        break;
    }
    onClose();
  };

  // Tab / Shift+Tab cycle the category tabs — the palette is a single-field
  // dialog, so Tab has no focus to move and can carry navigation instead.
  const cycleFilter = (delta: number): void => {
    setFilter((current) => {
      const index = PALETTE_FILTERS.findIndex((option) => option.id === current);
      const next = (index + delta + PALETTE_FILTERS.length) % PALETTE_FILTERS.length;
      return PALETTE_FILTERS[next].id;
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab" && !looksLikePath) {
      e.preventDefault();
      cycleFilter(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIndex];
      if (item) activate(item);
    } else if (e.key === "Escape") {
      // A typed query is the nearer state to undo — clear it first, close on
      // the second press.
      if (query) setQuery("");
      else onClose();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* No explicit `journey` on the palette: it navigates ANYWHERE, so it has
          no journey of its own. Letting the ambient super-property stand keeps
          the useful fact — which journey the user reached for it FROM. */}
      <div
        className="modal command-palette"
        onClick={(e) => e.stopPropagation()}
        {...trackingAttrs({ dialog: "command_palette" })}
      >
        <div className="command-palette-search">
          <Icon name="Search" size={16} />
          <input
            ref={inputRef}
            className="command-palette-input"
            data-testid="command-palette-input"
            aria-label="Jump to a session, agent, or path"
            placeholder="Jump to a session, agent, or path…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button
              type="button"
              className="command-palette-clear"
              data-testid="command-palette-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <Icon name="X" size={14} />
            </button>
          )}
        </div>
        {!looksLikePath && (
          <div
            ref={filterTabs.trackRef}
            className="command-palette-filters tab-track"
            role="tablist"
            aria-label="Search filter"
          >
            <span className="tab-indicator" style={filterTabs.style} aria-hidden="true" />
            {PALETTE_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={filter === option.id}
                className={"command-palette-filter" + (filter === option.id ? " is-active" : "")}
                data-testid={`command-palette-filter-${option.id}`}
                onClick={() => {
                  setFilter(option.id);
                  inputRef.current?.focus();
                }}
              >
                <Icon name={option.icon} size={14} />
                {option.label}
              </button>
            ))}
          </div>
        )}
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
                className={
                  "command-palette-item" +
                  (index === selectedIndex ? " is-selected" : "") +
                  (item.current ? " is-current" : "")
                }
                data-testid={`command-palette-item-${index}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => activate(item)}
              >
                <Icon name={item.icon ?? ICON_FOR_KIND[item.kind]} size={14} />
                <span className="command-palette-item-label">{highlightText(item.label, item.labelIndices)}</span>
                {item.current && <span className="command-palette-current">current</span>}
                <span
                  className="command-palette-item-meta"
                  data-code={item.path != null || item.kind === "session" || item.kind === "past" || undefined}
                >
                  {item.meta ? highlightText(item.meta, item.metaIndices) : null}
                </span>
              </button>
            </div>
          ))}
        </div>
        <div className="command-palette-footer" data-testid="command-palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          {!looksLikePath && (
            <span>
              <kbd>tab</kbd> category
            </span>
          )}
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          {destination ? (
            <button
              type="button"
              className="btn-ghost command-palette-footer-cta"
              data-testid="command-palette-destination"
              onClick={() => {
                if (destination.href) {
                  window.open(destination.href, "_blank", "noopener,noreferrer");
                } else if (destination.actionId) {
                  const verb = actions.find((action) => action.id === destination.actionId);
                  if (verb) {
                    verb.run();
                    onClose();
                  }
                }
              }}
            >
              {destination.label}
              <Icon name={destination.href ? "ExternalLink" : "ArrowRight"} size={14} />
            </button>
          ) : (
            <span className="command-palette-footer-mod">
              <kbd>{MOD_LABEL}</kbd>
              <kbd>K</kbd> anytime
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
