import { useEffect, useState } from "react";
import type { JSX } from "react";

import type { FsListEntry, FsListResponse } from "../lib/api";
import { Icon } from "./Icon";

interface DirectoryPickerProps {
  value: string;
  onChange: (path: string) => void;
  /** Enter with no matching subdirectory to drill into — treated as "confirm this path". */
  onSubmit: () => void;
  recentDirs: string[];
  listDir: (path?: string) => Promise<FsListResponse>;
}

/**
 * Combobox for the new-session directory field: free-text entry backed by
 * server-side autocomplete (GET /api/fs/list). Typing filters the current
 * directory's subdirectories by name; clicking one (or matching it exactly
 * and pressing Enter) drills into it; the "up" button walks to the parent.
 */
export function DirectoryPicker({ value, onChange, onSubmit, recentDirs, listDir }: DirectoryPickerProps): JSX.Element {
  const [browsePath, setBrowsePath] = useState(value);
  const [dirs, setDirs] = useState<FsListEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      listDir(value || undefined)
        .then((res) => {
          if (cancelled) return;
          setBrowsePath(res.path);
          setDirs(res.dirs);
          setParent(res.parent);
        })
        .catch(() => {})
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // If the listing resolved to an ancestor of what was typed (the tail didn't
  // exist yet), that tail is a type-ahead filter over the ancestor's children.
  const tail = value.startsWith(browsePath) ? value.slice(browsePath.length).replace(/^\//, "") : "";
  const filteredDirs = tail ? dirs.filter((d) => d.name.toLowerCase().startsWith(tail.toLowerCase())) : dirs;

  const navigate = (path: string): void => onChange(path);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      if (filteredDirs.length > 0) {
        navigate(filteredDirs[0].path);
      } else {
        onSubmit();
      }
    }
  };

  return (
    <div className="dir-picker">
      <div className="dir-picker-inputrow">
        <button
          type="button"
          className="dir-picker-up"
          data-testid="dir-picker-up"
          disabled={!parent}
          onClick={() => parent && navigate(parent)}
          title="Up to parent directory"
        >
          <Icon name="CornerLeftUp" size={14} />
        </button>
        <input
          id="new-session-cwd"
          autoFocus
          className="modal-input dir-picker-input"
          data-testid="dir-picker-input"
          value={value}
          placeholder="/path/to/project"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>

      {recentDirs.length > 0 && (
        <div className="recent-dirs">
          {recentDirs.map((dir) => (
            <button key={dir} type="button" className="recent-dir-chip" onClick={() => navigate(dir)}>
              {dir}
            </button>
          ))}
        </div>
      )}

      <div className="dir-picker-listing" data-testid="dir-picker-listing">
        <div className="dir-picker-path">{browsePath}</div>
        {loading && <div className="dir-picker-empty">Loading…</div>}
        {!loading && filteredDirs.length === 0 && <div className="dir-picker-empty">No subdirectories</div>}
        {!loading &&
          filteredDirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="dir-picker-item"
              data-testid={`dir-picker-item-${entry.name}`}
              onClick={() => navigate(entry.path)}
            >
              <Icon name="Folder" size={13} />
              {entry.name}
            </button>
          ))}
      </div>
    </div>
  );
}
