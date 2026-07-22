import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { FsDirEntry, FsListResponse } from "../lib/api";
import { Icon } from "./Icon";

/** "/Users/…/onboarding-flow" — middle-truncates a long path so a chip row
 *  never hard-clips a chip mid-glyph; the full path stays in the tooltip. */
function middleTruncatePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return path;
  return `/${segments[0]}/…/${segments[segments.length - 1]}`;
}

interface DirectoryPickerProps {
  value: string;
  onChange: (path: string) => void;
  /** Enter with no matching subdirectory to drill into — treated as "confirm this path". */
  onSubmit: () => void;
  recentDirs: string[];
  listDir: (path?: string) => Promise<FsListResponse>;
  /** Fires when the typed tail flips between existing and not-yet-existing. */
  onNewDirChange?: (newDir: boolean) => void;
}

/**
 * Combobox for the new-session directory field: free-text entry backed by
 * server-side autocomplete (GET /api/fs/list). Typing filters the current
 * directory's subdirectories by name; clicking one (or matching it exactly
 * and pressing Enter) drills into it; the "up" button walks to the parent.
 */
export function DirectoryPicker({
  value,
  onChange,
  onSubmit,
  recentDirs,
  listDir,
  onNewDirChange,
}: DirectoryPickerProps): JSX.Element {
  const [browsePath, setBrowsePath] = useState(value);
  const [dirs, setDirs] = useState<FsDirEntry[]>([]);
  // Always a real path (root's parent is itself, per path.dirname("/") === "/") —
  // "no further up" is `parent === browsePath`, not null.
  const [parent, setParent] = useState(value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [listingOpen, setListingOpen] = useState(true);

  // Typed path doesn't exist (yet) but its parent does — that's a NEW
  // directory being named, not an error: the server creates it on start.
  const [newDir, setNewDir] = useState(false);

  // Bumped by the error state's Retry — refires the listing fetch for the
  // same value (a transient read failure shouldn't require retyping).
  const [retryNonce, setRetryNonce] = useState(0);

  // Which edges of the chip row are clipped by scroll — drives the fade
  // masks so an overflowing row never hard-clips a chip without saying
  // "there's more".
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipsFade, setChipsFade] = useState<"none" | "left" | "right" | "both">("none");
  const updateChipsFade = (): void => {
    const el = chipsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setChipsFade(left && right ? "both" : left ? "left" : right ? "right" : "none");
  };
  useEffect(() => {
    updateChipsFade();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentDirs]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNewDir(false);
    const parentOf = (path: string): string | null => {
      const trimmed = path.replace(/\/+$/, "");
      const cut = trimmed.slice(0, trimmed.lastIndexOf("/"));
      if (!trimmed.includes("/") || cut === trimmed) return null;
      return cut || "/";
    };
    const handle = setTimeout(() => {
      listDir(value || undefined)
        .then((res) => {
          if (cancelled) return;
          setBrowsePath(res.path);
          setDirs(res.dirs);
          setParent(res.parent);
        })
        .catch(async () => {
          // Ancestor fallback: the mock resolves missing tails itself, but
          // the real server 404s — retry the parent so type-ahead (and the
          // new-directory case) work against both.
          const up = parentOf(value);
          if (!up || cancelled) {
            if (!cancelled) setError("Couldn't read that directory.");
            return;
          }
          try {
            const res = await listDir(up);
            if (cancelled) return;
            setBrowsePath(res.path);
            setDirs(res.dirs);
            setParent(res.parent);
            setNewDir(true);
          } catch {
            if (!cancelled) setError("Couldn't read that directory.");
          }
        })
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, retryNonce]);

  // If the listing resolved to an ancestor of what was typed (the tail didn't
  // exist yet), that tail is a type-ahead filter over the ancestor's children.
  const tail = value.startsWith(browsePath) ? value.slice(browsePath.length).replace(/^\//, "") : "";
  const filteredDirs = tail ? dirs.filter((d) => d.name.toLowerCase().startsWith(tail.toLowerCase())) : dirs;
  const clampedHighlight = Math.min(highlight, Math.max(filteredDirs.length - 1, 0));

  // "This names a directory that doesn't exist yet" — true whether the
  // server 404ed (ancestor fallback above) or resolved the ancestor itself
  // leaving an unmatched tail (the mock's behavior).
  const typedNewDir = !loading && !error && filteredDirs.length === 0 && (newDir || tail !== "");
  useEffect(() => {
    onNewDirChange?.(typedNewDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedNewDir]);

  const navigate = (path: string): void => onChange(path);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Arrow keys drive the listing ONLY while there is a listing to drive —
    // otherwise they stay ordinary caret movement (Home/End/←/→ always do).
    const listNavigable = listingOpen && filteredDirs.length > 0;
    if (e.key === "ArrowDown" && listNavigable) {
      e.preventDefault();
      setHighlight(Math.min(clampedHighlight + 1, filteredDirs.length - 1));
    } else if (e.key === "ArrowUp" && listNavigable) {
      e.preventDefault();
      setHighlight(Math.max(clampedHighlight - 1, 0));
    } else if (e.key === "Enter") {
      if (listNavigable) {
        navigate(filteredDirs[clampedHighlight]?.path ?? filteredDirs[0].path);
        setHighlight(0);
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
          disabled={parent === browsePath}
          onClick={() => navigate(parent)}
          aria-label="Up to parent directory"
          data-tooltip="Up to parent directory"
        >
          <Icon name="CornerLeftUp" size={14} />
        </button>
        <input
          id="new-session-cwd"
          autoFocus
          aria-label="Project directory"
          className="modal-input dir-picker-input"
          data-testid="dir-picker-input"
          value={value}
          placeholder="/path/to/project"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className={"dir-picker-up dir-picker-browse" + (listingOpen ? " is-active" : "")}
          data-testid="dir-picker-browse"
          aria-pressed={listingOpen}
          onClick={() => {
            // Browse semantics: open the listing, and if the typed tail is a
            // dead end (matches nothing), step back to the nearest real
            // directory so there is something to browse.
            if (!listingOpen) {
              setListingOpen(true);
              return;
            }
            if (typedNewDir && browsePath && browsePath !== value) navigate(browsePath);
            else setListingOpen(false);
          }}
          aria-label="Browse subdirectories"
          data-tooltip={
            listingOpen
              ? typedNewDir
                ? "Browse the nearest existing folder"
                : "Hide the directory listing"
              : "Browse subdirectories"
          }
        >
          <Icon name="Folder" size={14} />
        </button>
      </div>

      {recentDirs.length > 0 && (
        <div className="recent-dirs" ref={chipsRef} data-fade={chipsFade} onScroll={updateChipsFade}>
          {recentDirs.map((dir) => (
            <button
              key={dir}
              type="button"
              className="recent-dir-chip"
              title={dir}
              onClick={() => navigate(dir)}
            >
              {middleTruncatePath(dir)}
            </button>
          ))}
        </div>
      )}

      {listingOpen && (
      <div className="dir-picker-listing" data-testid="dir-picker-listing">
        <div className="dir-picker-path">{browsePath}</div>
        {loading && <div className="dir-picker-empty">Loading…</div>}
        {!loading && error && (
          <div className="dir-picker-error" data-testid="dir-picker-error" role="alert">
            <Icon name="TriangleAlert" size={14} />
            <span>{error}</span>
            {/* Same recovery contract as the canvas error card: the
                failure always carries its own retry. */}
            <button
              type="button"
              className="btn-ghost dir-picker-retry"
              data-testid="dir-picker-retry"
              onClick={() => setRetryNonce((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        )}
        {typedNewDir && (
          <div className="dir-picker-newdir" data-testid="dir-picker-newdir">
            New folder. It will be created when you start.
          </div>
        )}
        {!loading && !error && !typedNewDir && filteredDirs.length === 0 && (
          <div className="dir-picker-empty">No subdirectories</div>
        )}
        {!loading &&
          !error &&
          filteredDirs.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              className={"dir-picker-item" + (index === clampedHighlight ? " is-selected" : "")}
              data-testid={`dir-picker-item-${entry.name}`}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => navigate(entry.path)}
            >
              <Icon name="Folder" size={13} />
              {entry.name}
            </button>
          ))}
      </div>
      )}
    </div>
  );
}
