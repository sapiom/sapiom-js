import * as fs from "node:fs";
import * as path from "node:path";
import { CANVAS_DIR } from "../shared/types.js";

const DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 500;

export interface CanvasWatcherHandle {
  close(): void;
}

/**
 * Cheap change fingerprint for a directory tree: sorted `path:mtime:size`
 * entries. Used by the polling fallback (and directly testable on its own)
 * — not a content hash, just enough to notice something moved.
 */
export function snapshotCanvasDir(canvasDir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(canvasDir, { recursive: true }) as string[];
  } catch {
    return "";
  }

  const parts = entries.map((entry) => {
    try {
      const stat = fs.statSync(path.join(canvasDir, entry));
      return `${entry}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${entry}:gone`;
    }
  });
  return parts.sort().join("|");
}

/**
 * Watches a session's canvas directory (`<cwd>/.sapiom/canvas`, see
 * CANVAS_DIR) and invokes `onReload` (debounced) whenever its contents
 * change. The agent may not have created the directory yet when the session
 * starts, so this watches the whole project root recursively and filters for
 * changes under the canvas dir — that way there's no separate "wait for it
 * to appear" phase.
 */
export function watchCanvas(cwd: string, onReload: () => void): CanvasWatcherHandle {
  const canvasDir = path.join(cwd, CANVAS_DIR);
  const canvasPrefix = CANVAS_DIR + path.sep;

  let watcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastSnapshot = "";

  const debouncedReload = (): void => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onReload, DEBOUNCE_MS);
  };

  const isCanvasPath = (filename: string | null): boolean => {
    // A `null` filename means the platform couldn't report which path
    // changed — reload to be safe rather than miss an update.
    if (!filename) return true;
    return filename === CANVAS_DIR || filename.startsWith(canvasPrefix);
  };

  try {
    watcher = fs.watch(cwd, { recursive: true }, (_event, filename) => {
      if (isCanvasPath(filename)) debouncedReload();
    });
  } catch {
    // `recursive` watch isn't available on this platform (notably Linux) —
    // fall back to polling a directory-tree fingerprint.
    lastSnapshot = snapshotCanvasDir(canvasDir);
    pollTimer = setInterval(() => {
      const snapshot = snapshotCanvasDir(canvasDir);
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        debouncedReload();
      }
    }, POLL_INTERVAL_MS);
  }

  return {
    close(): void {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      watcher?.close();
    },
  };
}
