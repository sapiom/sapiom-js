import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { FsDirEntry, FsListResponse } from "../lib/api";
import { Icon } from "./Icon";

// ---------------------------------------------------------------------------
// Static favorites — Home plus common child directories. The browser
// attempts to list each one; entries that resolve successfully are shown,
// entries that 404 (e.g. the user has no ~/Desktop) are silently dropped.
// ---------------------------------------------------------------------------

const FAVORITES: { label: string; path: string; icon: string }[] = [
  { label: "Home", path: "~", icon: "Home" },
  { label: "Desktop", path: "~/Desktop", icon: "Folder" },
  { label: "Documents", path: "~/Documents", icon: "Folder" },
  { label: "Downloads", path: "~/Downloads", icon: "Folder" },
];

// ---------------------------------------------------------------------------
// Breadcrumb helpers
// ---------------------------------------------------------------------------

/** Split an absolute path into clickable segments.
 *  "/Users/demo/acme-app" → [{label:"/", path:"/"}, {label:"Users", path:"/Users"}, …] */
export function buildBreadcrumbs(absPath: string): { label: string; path: string }[] {
  if (!absPath || absPath === "/") return [{ label: "/", path: "/" }];
  const segments = absPath.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let running = "";
  for (const seg of segments) {
    running = `${running}/${seg}`;
    crumbs.push({ label: seg, path: running });
  }
  return crumbs;
}

// ---------------------------------------------------------------------------
// FolderBrowser props
// ---------------------------------------------------------------------------

export interface FolderBrowserProps {
  /** Current selected path (controlled by parent). */
  value: string;
  onChange: (path: string) => void;
  /** Called when the user confirms the currently browsed folder (primary CTA). */
  onOpen: () => void;
  recentDirs: string[];
  listDir: (path?: string) => Promise<FsListResponse>;
  /**
   * Called whenever the "or type a path" secondary input names a directory
   * that doesn't exist yet (the server walked up to the nearest ancestor).
   * Pass `true` when the typed path is new (parent exists, leaf doesn't),
   * `false` when the typed path resolved to itself or the input was cleared.
   * The parent can use this to gate scaffold / scan / "Add project" actions.
   */
  onNewDirChange?: (isNew: boolean) => void;
}

// ---------------------------------------------------------------------------
// FolderBrowser
// ---------------------------------------------------------------------------

/**
 * Browse-first folder picker used in the "Open Folder", new-session, and
 * template-use flows.
 *
 * Layout, top to bottom:
 *   1. Favorites row (Home / Desktop / Documents / Downloads) + Recents chips
 *   2. Breadcrumb bar — click any ancestor to navigate there
 *   3. Folder list — click a subfolder to drill in
 *   4. "Open this folder" primary button
 *   5. Secondary "or type a path" collapsible input
 */
export function FolderBrowser({
  value,
  onChange,
  onOpen,
  recentDirs,
  listDir,
  onNewDirChange,
}: FolderBrowserProps): JSX.Element {
  // Which real directory is currently being shown in the listing.
  const [browsePath, setBrowsePath] = useState(value || "~");
  const [parent, setParent] = useState("/");
  const [dirs, setDirs] = useState<FsDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Tracks whether the currently selected path is a new (non-existent)
  // directory typed by the user via the "or type a path" secondary input.
  const [newDirTyped, setNewDirTyped] = useState(false);

  // Favorites: after first mount we probe each favorite and keep only the
  // ones that listed successfully.
  const [liveFavorites, setLiveFavorites] = useState<typeof FAVORITES>([]);

  // Secondary path input (collapsed by default).
  const [showTypePath, setShowTypePath] = useState(false);
  const [typedPath, setTypedPath] = useState("");

  // When the user types a path via "or type a path", we remember the raw
  // request so we can detect whether it resolved (exists) or walked up
  // (doesn't exist yet).  null means the last navigation was via the browser
  // (click/favorite/breadcrumb), not a typed submission.
  const [requestedTypedPath, setRequestedTypedPath] = useState<string | null>(null);

  const typePathRef = useRef<HTMLInputElement>(null);

  // Probe favorites on mount — fire all in parallel, keep successes.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled(
      FAVORITES.map(async (fav) => {
        await listDir(fav.path);
        return fav;
      }),
    ).then((results) => {
      if (cancelled) return;
      const alive = results
        .filter((r): r is PromiseFulfilledResult<(typeof FAVORITES)[number]> => r.status === "fulfilled")
        .map((r) => r.value);
      setLiveFavorites(alive);
    });
    return () => {
      cancelled = true;
    };
    // Only run once on mount — listDir identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch listing whenever the browsed path changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    /** Compute the parent of a path. */
    const parentOf = (p: string): string | null => {
      const trimmed = p.replace(/\/+$/, "");
      const cut = trimmed.slice(0, trimmed.lastIndexOf("/"));
      if (!trimmed.includes("/") || cut === trimmed) return null;
      return cut || "/";
    };

    const handle = setTimeout(() => {
      listDir(browsePath || undefined)
        .then((res) => {
          if (cancelled) return;
          setBrowsePath(res.path);
          setParent(res.parent);
          setDirs(res.dirs);

          // Detect whether the path that was requested doesn't exist yet: the
          // server walks up to the nearest real ancestor, so res.path differs
          // from the originally requested path when the leaf is new.
          //
          // Two entry-points produce a non-existent path:
          //   1. The user types one via "or type a path" — requestedTypedPath
          //      holds the raw input.
          //   2. The initial value passed by the parent is an absolute path that
          //      doesn't exist yet (e.g. a suggested template destination).
          //      In this case requestedTypedPath is null, but browsePath is an
          //      absolute path whose tail didn't exist. We detect this by checking
          //      that browsePath starts with "/" (absolute), res.path is a proper
          //      ancestor of browsePath, and the response walked up (not just
          //      expanded a tilde alias).
          const walkedUp = res.path !== browsePath;
          const isAbsoluteWalkUp =
            requestedTypedPath == null &&
            walkedUp &&
            browsePath.startsWith("/") &&
            browsePath.startsWith(res.path + "/");
          const isNew =
            requestedTypedPath != null
              ? walkedUp && res.path !== requestedTypedPath
              : isAbsoluteWalkUp;
          if (isNew) {
            // The path is new — keep the original requested value as the
            // controlled value so the parent's submit / scaffold use it, while
            // the browser shows the resolved ancestor's listing.
            setNewDirTyped(true);
            // Use the typed path if available, otherwise the original browsePath.
            onChange(requestedTypedPath ?? browsePath);
          } else {
            // Resolved to an existing directory (browse navigation, tilde
            // expansion, or typed path that already exists) — sync normally.
            setNewDirTyped(false);
            onChange(res.path);
          }
          if (onNewDirChange) onNewDirChange(isNew);
        })
        .catch(async () => {
          // B1: The real server returns 404 for non-existent paths (unlike the
          // mock which walks up itself).  Ancestor fallback: retry the parent
          // for typed paths and absolute initial values so a new-folder path
          // still shows the scaffold CTA instead of an error.
          const canRetry = requestedTypedPath != null || browsePath.startsWith("/");
          if (!canRetry) {
            // Tilde-relative path that the real server can't read — show error.
            if (!cancelled) {
              setError("Couldn't read that directory.");
              onNewDirChange?.(false); // B2
            }
            return;
          }
          const up = parentOf(browsePath);
          if (!up || cancelled) {
            if (!cancelled) {
              setError("Couldn't read that directory.");
              onNewDirChange?.(false); // B2
            }
            return;
          }
          try {
            const res = await listDir(up);
            if (cancelled) return;
            // Parent exists — the requested path is a new directory.
            setBrowsePath(res.path);
            setParent(res.parent);
            setDirs(res.dirs);
            setNewDirTyped(true);
            // Preserve the original path (typed or initial absolute value).
            onChange(requestedTypedPath ?? browsePath);
            onNewDirChange?.(true);
          } catch {
            if (!cancelled) {
              setError("Couldn't read that directory.");
              onNewDirChange?.(false); // B2
            }
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsePath, retryNonce]);

  // When the secondary type-path input is revealed, focus it.
  useEffect(() => {
    if (showTypePath) typePathRef.current?.focus();
  }, [showTypePath]);

  // Browse navigation (favorites / breadcrumbs / folder list / recents) —
  // always navigates to an existing directory.
  const navigateTo = (path: string): void => {
    setRequestedTypedPath(null);
    // Clear any new-dir flag from a previous typed path navigation.
    if (newDirTyped) {
      setNewDirTyped(false);
      if (onNewDirChange) onNewDirChange(false);
    }
    setBrowsePath(path);
    setTypedPath("");
    // Eagerly sync the controlled value so the parent's onOpen/submit always
    // sees the current navigation intent — the listing may still be loading.
    onChange(path);
  };

  // "Or type a path" submission — may name a new (non-existent) directory.
  const navigateToTyped = (path: string): void => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setRequestedTypedPath(trimmed);
    // Eagerly set the controlled value to the typed path so the parent's
    // submit action works even before the listing resolves.
    onChange(trimmed);
    setBrowsePath(trimmed);
    setTypedPath("");
  };

  const handleTypePathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && typedPath.trim()) {
      navigateToTyped(typedPath.trim());
      setShowTypePath(false);
    }
  };

  const breadcrumbs = buildBreadcrumbs(browsePath);
  const atRoot = parent === browsePath;

  return (
    <div className="folder-browser">
      {/* ---- Favorites + Recents ---- */}
      {(liveFavorites.length > 0 || recentDirs.length > 0) && (
        <div className="folder-browser-quicklinks" data-testid="folder-browser-quicklinks">
          {liveFavorites.length > 0 && (
            <div className="folder-browser-favorites" data-testid="folder-browser-favorites">
              {liveFavorites.map((fav) => (
                <button
                  key={fav.path}
                  type="button"
                  className="folder-browser-fav-btn"
                  data-testid={`folder-browser-fav-${fav.label.toLowerCase()}`}
                  onClick={() => navigateTo(fav.path)}
                  title={fav.path}
                >
                  <Icon name={fav.icon} size={13} />
                  {fav.label}
                </button>
              ))}
            </div>
          )}
          {recentDirs.length > 0 && (
            <div className="folder-browser-recents" data-testid="folder-browser-recents">
              <span className="folder-browser-section-label">
                <Icon name="History" size={11} />
                Recent
              </span>
              {recentDirs.map((dir) => (
                <button
                  key={dir}
                  type="button"
                  className="folder-browser-recent-btn"
                  data-testid={`folder-browser-recent-${dir.split("/").pop() ?? dir}`}
                  title={dir}
                  onClick={() => navigateTo(dir)}
                >
                  {dir.split("/").filter(Boolean).pop() ?? dir}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Breadcrumb bar ---- */}
      <div className="folder-browser-breadcrumbs" data-testid="folder-browser-breadcrumbs">
        <button
          type="button"
          className="folder-browser-up"
          data-testid="folder-browser-up"
          disabled={atRoot}
          onClick={() => navigateTo(parent)}
          aria-label="Up to parent directory"
          title="Up to parent directory"
        >
          <Icon name="CornerLeftUp" size={13} />
        </button>
        <div className="folder-browser-crumb-row" role="navigation" aria-label="Current path">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} className="folder-browser-crumb-segment">
              {i > 0 && (
                <span className="folder-browser-crumb-sep" aria-hidden="true">
                  <Icon name="ChevronRight" size={11} />
                </span>
              )}
              <button
                type="button"
                className={
                  "folder-browser-crumb-btn" + (i === breadcrumbs.length - 1 ? " is-current" : "")
                }
                data-testid={`folder-browser-crumb-${crumb.label}`}
                onClick={() => {
                  if (i < breadcrumbs.length - 1) navigateTo(crumb.path);
                }}
                disabled={i === breadcrumbs.length - 1}
                aria-current={i === breadcrumbs.length - 1 ? "location" : undefined}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* ---- Folder listing ---- */}
      <div className="folder-browser-listing" data-testid="folder-browser-listing">
        {loading && <div className="dir-picker-empty">Loading…</div>}
        {!loading && error && (
          <div className="dir-picker-error" data-testid="folder-browser-error" role="alert">
            <Icon name="TriangleAlert" size={14} />
            <span>{error}</span>
            <button
              type="button"
              className="btn-ghost dir-picker-retry"
              data-testid="folder-browser-retry"
              onClick={() => setRetryNonce((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        )}
        {!loading && !error && dirs.length === 0 && (
          <div className="dir-picker-empty">No subfolders</div>
        )}
        {!loading &&
          !error &&
          dirs.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="dir-picker-item"
              data-testid={`folder-browser-item-${entry.name}`}
              onClick={() => navigateTo(entry.path)}
            >
              <Icon name="Folder" size={13} />
              {entry.name}
            </button>
          ))}
      </div>

      {/* ---- "Open this folder" primary CTA ---- */}
      <div className="folder-browser-actions" data-testid="folder-browser-actions">
        <button
          type="button"
          className="btn-primary folder-browser-open-btn"
          data-testid="folder-browser-open"
          onClick={onOpen}
          disabled={!value.trim()}
        >
          <Icon name="Folder" size={14} />
          Open this folder
        </button>
      </div>

      {/* ---- Secondary: type a path ---- */}
      <div className="folder-browser-type-path" data-testid="folder-browser-type-path-area">
        {!showTypePath ? (
          <button
            type="button"
            className="btn-ghost folder-browser-type-toggle"
            data-testid="folder-browser-type-toggle"
            onClick={() => {
              setTypedPath(browsePath);
              setShowTypePath(true);
            }}
          >
            or type a path…
          </button>
        ) : (
          <div className="folder-browser-type-row">
            <input
              ref={typePathRef}
              className="modal-input dir-picker-input folder-browser-type-input"
              data-testid="folder-browser-type-input"
              aria-label="Type a path"
              placeholder="/path/to/project"
              value={typedPath}
              onChange={(e) => setTypedPath(e.target.value)}
              onKeyDown={handleTypePathKeyDown}
            />
            <button
              type="button"
              className="btn-ghost folder-browser-type-go"
              data-testid="folder-browser-type-go"
              disabled={!typedPath.trim()}
              onClick={() => {
                if (typedPath.trim()) {
                  navigateToTyped(typedPath.trim());
                  setShowTypePath(false);
                }
              }}
            >
              Go
            </button>
            <button
              type="button"
              className="btn-ghost folder-browser-type-cancel"
              data-testid="folder-browser-type-cancel"
              onClick={() => setShowTypePath(false)}
            >
              <Icon name="X" size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
