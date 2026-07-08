import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { HarnessSession, WorkflowInfo } from "@shared/types";

import type { FsDirEntry, FsListResponse } from "../lib/api";
import { fuzzyScore } from "../lib/fuzzy";
import { Icon } from "./Icon";

interface PaletteItem {
  id: string;
  kind: "session" | "workflow" | "recent" | "path";
  label: string;
  meta: string;
  sessionId?: string;
  path?: string;
}

interface CommandPaletteProps {
  sessions: HarnessSession[];
  workflows: WorkflowInfo[];
  recentDirs: string[];
  listDir: (path?: string) => Promise<FsListResponse>;
  onSelectSession: (id: string) => void;
  onOpenPath: (cwd: string) => void;
  onClose: () => void;
}

const ICON_FOR_KIND: Record<PaletteItem["kind"], string> = {
  session: "Radio",
  workflow: "Folder",
  recent: "Folder",
  path: "Folder",
};

/**
 * Cmd+K / Cmd+P quick-jump: fuzzy match over running sessions, workflow
 * paths, and recent directories. When the query looks like a path, GET
 * /api/fs/list drives live directory completion instead. Enter switches to a
 * session hit, or starts a fresh session at a path hit — no intermediate
 * dialog, matching the "jump straight there" feel this was modeled on.
 */
export function CommandPalette({
  sessions,
  workflows,
  recentDirs,
  listDir,
  onSelectSession,
  onOpenPath,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [pathDirs, setPathDirs] = useState<FsDirEntry[]>([]);
  const [pathLoading, setPathLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const looksLikePath = query.startsWith("/") || query.startsWith("~");

  useEffect(() => {
    if (!looksLikePath) {
      setPathDirs([]);
      return;
    }
    let cancelled = false;
    setPathLoading(true);
    const handle = setTimeout(() => {
      listDir(query)
        .then((res) => {
          if (!cancelled) setPathDirs(res.dirs);
        })
        .catch(() => {})
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

    const workflowItems: PaletteItem[] = workflows.map((workflow) => ({
      id: `workflow:${workflow.path}`,
      kind: "workflow",
      label: workflow.name,
      meta: workflow.path,
      path: workflow.path,
    }));

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

    const all = [...sessionItems, ...workflowItems, ...recentItems];
    if (!query) return all.slice(0, 20);

    return all
      .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.meta}`) }))
      .filter((entry): entry is { item: PaletteItem; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
      .slice(0, 20);
  }, [query, looksLikePath, pathDirs, sessions, workflows, recentDirs]);

  useEffect(() => setSelectedIndex(0), [items.length, query]);

  const activate = (item: PaletteItem): void => {
    if (item.kind === "session" && item.sessionId) {
      onSelectSession(item.sessionId);
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
          {items.length === 0 && !pathLoading && <div className="command-palette-empty">No matches</div>}
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={"command-palette-item" + (index === selectedIndex ? " is-selected" : "")}
              data-testid={`command-palette-item-${index}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => activate(item)}
            >
              <Icon name={ICON_FOR_KIND[item.kind]} size={14} />
              <span className="command-palette-item-label">{item.label}</span>
              <span className="command-palette-item-meta">{item.meta}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
