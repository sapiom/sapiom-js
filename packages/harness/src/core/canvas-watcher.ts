import * as fs from "node:fs";
import * as path from "node:path";
import { CANVAS_DIR } from "../shared/types.js";

const DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 500;

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
 * One session's watcher. Watches the whole project root (not the canvas dir
 * directly) recursively and filters to CANVAS_DIR-prefixed changes — so
 * there's no separate "wait for the dir to appear" phase, and it naturally
 * survives the canvas dir itself being deleted/recreated. Falls back to
 * polling a directory-tree fingerprint when recursive `fs.watch` isn't
 * available (notably Linux) or the watcher errors out at runtime.
 */
class SessionCanvasWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastSnapshot = "";
  private readonly canvasDir: string;
  private readonly canvasPrefix: string;

  constructor(
    private readonly cwd: string,
    private readonly harnessSessionId: string,
    private readonly onChange: (harnessSessionId: string) => void,
  ) {
    this.canvasDir = path.join(cwd, CANVAS_DIR);
    this.canvasPrefix = CANVAS_DIR + path.sep;
    this.arm();
  }

  private scheduleChange(): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.onChange(this.harnessSessionId), DEBOUNCE_MS);
  }

  private isCanvasPath(filename: string | null): boolean {
    // A `null` filename means the platform couldn't report which path
    // changed — reload to be safe rather than miss an update.
    if (!filename) return true;
    return filename === CANVAS_DIR || filename.startsWith(this.canvasPrefix);
  }

  private arm(): void {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(this.cwd, { recursive: true }, (event, filename) => {
        if (!this.isCanvasPath(filename)) return;
        this.scheduleChange();
        // A rename at (or above) the canvas dir — e.g. an editor's atomic
        // write-then-rename, or the agent `mkdir -p`'ing it for the first
        // time — can leave a recursive watcher no longer covering the new
        // inode on some platforms. Re-arm defensively rather than risk
        // silently going deaf.
        if (event === "rename" && (filename === CANVAS_DIR || filename === path.dirname(CANVAS_DIR))) {
          this.rearm();
        }
      });
      this.watcher.on("error", () => this.fallBackToPolling());
    } catch {
      // `recursive` isn't supported on this platform (notably Linux).
      this.fallBackToPolling();
    }
  }

  private rearm(): void {
    this.watcher?.close();
    this.watcher = null;
    this.arm();
  }

  private fallBackToPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.watcher?.close();
    this.watcher = null;
    this.lastSnapshot = snapshotCanvasDir(this.canvasDir);
    this.pollTimer = setInterval(() => {
      const snapshot = snapshotCanvasDir(this.canvasDir);
      if (snapshot !== this.lastSnapshot) {
        this.lastSnapshot = snapshot;
        this.scheduleChange();
      }
    }, POLL_INTERVAL_MS);
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}

export interface CanvasWatcherManagerDeps {
  /** Debounced per-session change notification — the integrator broadcasts
   *  `{type: "canvas.reload", harnessSessionId}` on /ws/events from this. */
  onChange(harnessSessionId: string): void;
}

/** Registry of one SessionCanvasWatcher per active harness session. */
export class CanvasWatcherManager {
  private readonly watchers = new Map<string, SessionCanvasWatcher>();

  constructor(private readonly deps: CanvasWatcherManagerDeps) {}

  /** Idempotent: replaces any existing watcher for this session (e.g. a resume
   *  into a different cwd). */
  start(harnessSessionId: string, cwd: string): void {
    this.stop(harnessSessionId);
    this.watchers.set(
      harnessSessionId,
      new SessionCanvasWatcher(cwd, harnessSessionId, (id) => this.deps.onChange(id)),
    );
  }

  stop(harnessSessionId: string): void {
    this.watchers.get(harnessSessionId)?.close();
    this.watchers.delete(harnessSessionId);
  }

  stopAll(): void {
    for (const harnessSessionId of [...this.watchers.keys()]) this.stop(harnessSessionId);
  }

  /** Test/debug helper — how many sessions currently have an active watcher. */
  get size(): number {
    return this.watchers.size;
  }
}
