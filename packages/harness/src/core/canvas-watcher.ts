import * as fs from "node:fs";
import * as path from "node:path";
import { CANVAS_DIR } from "../shared/types.js";

const DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 500;

/** Directories a workflow-source walk never descends into (heavy or generated)
 *  — mirrors core/canvas-interconnections.ts's `listSourceFiles`. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".sapiom"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
/** Bounds the polling snapshot walk — the extraction itself already caps at
 *  200 files; this is just a defensive ceiling on the fingerprint cost. */
const MAX_SOURCE_FILES = 400;

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
 * Cheap change fingerprint over a project's own `.ts`/`.tsx` sources (skipping
 * node_modules/dist/.git/.sapiom), the polling fallback's equivalent of
 * `snapshotCanvasDir` for the workflow SOURCE — so an editor save on a step
 * file is noticed on platforms without recursive `fs.watch` too. Bounded and
 * total: an unreadable dir simply contributes nothing.
 */
export function snapshotWorkflowSources(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    if (parts.length >= MAX_SOURCE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (parts.length >= MAX_SOURCE_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(full);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        try {
          const stat = fs.statSync(full);
          parts.push(`${full}:${stat.mtimeMs}:${stat.size}`);
        } catch {
          parts.push(`${full}:gone`);
        }
      }
    }
  };
  walk(root);
  return parts.sort().join("|");
}

/** The two things a session watcher reports, kept separate so the integrator
 *  can react differently: a rendered-output change reloads the iframe, a
 *  source change re-renders the bound workflow (which then flows back as an
 *  output change → reload). */
export interface SessionWatcherCallbacks {
  onCanvasChange: (harnessSessionId: string) => void;
  onSourceChange: (harnessSessionId: string) => void;
}

/**
 * One session's watcher. Watches the whole project root recursively and routes
 * each change: a change under CANVAS_DIR is a rendered-output change (reload
 * the iframe); a `.ts`/`.tsx` change anywhere else is a workflow-source change
 * (re-render). No separate "wait for the dir to appear" phase, and it survives
 * the canvas dir itself being deleted/recreated. Falls back to polling two
 * directory-tree fingerprints (canvas output + sources) when recursive
 * `fs.watch` isn't available (notably Linux) or the watcher errors out.
 */
class SessionCanvasWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private canvasDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private sourceDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastSnapshot = "";
  private lastSourceSnapshot = "";
  private readonly canvasDir: string;
  private readonly canvasPrefix: string;

  constructor(
    private readonly cwd: string,
    private readonly harnessSessionId: string,
    private readonly callbacks: SessionWatcherCallbacks,
  ) {
    this.canvasDir = path.join(cwd, CANVAS_DIR);
    this.canvasPrefix = CANVAS_DIR + path.sep;
    this.arm();
  }

  private scheduleCanvasChange(): void {
    if (this.closed) return;
    if (this.canvasDebounceTimer) clearTimeout(this.canvasDebounceTimer);
    this.canvasDebounceTimer = setTimeout(
      () => this.callbacks.onCanvasChange(this.harnessSessionId),
      DEBOUNCE_MS,
    );
  }

  private scheduleSourceChange(): void {
    if (this.closed) return;
    if (this.sourceDebounceTimer) clearTimeout(this.sourceDebounceTimer);
    this.sourceDebounceTimer = setTimeout(
      () => this.callbacks.onSourceChange(this.harnessSessionId),
      DEBOUNCE_MS,
    );
  }

  private isCanvasPath(filename: string): boolean {
    return filename === CANVAS_DIR || filename.startsWith(this.canvasPrefix);
  }

  private isWorkflowSourcePath(filename: string): boolean {
    if (!SOURCE_EXTENSIONS.has(path.extname(filename))) return false;
    return !filename.split(path.sep).some((seg) => SKIP_DIR_NAMES.has(seg));
  }

  private arm(): void {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(this.cwd, { recursive: true }, (event, filename) => {
        // A `null` filename means the platform couldn't report which path
        // changed — do both (reload AND re-render) rather than miss an update.
        if (filename === null) {
          this.scheduleCanvasChange();
          this.scheduleSourceChange();
          return;
        }
        if (this.isCanvasPath(filename)) {
          this.scheduleCanvasChange();
          // A rename at (or above) the canvas dir — e.g. an editor's atomic
          // write-then-rename, or the agent `mkdir -p`'ing it for the first
          // time — can leave a recursive watcher no longer covering the new
          // inode on some platforms. Re-arm defensively rather than risk
          // silently going deaf.
          if (event === "rename" && (filename === CANVAS_DIR || filename === path.dirname(CANVAS_DIR))) {
            this.rearm();
          }
          return;
        }
        if (this.isWorkflowSourcePath(filename)) this.scheduleSourceChange();
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
    this.lastSourceSnapshot = snapshotWorkflowSources(this.cwd);
    this.pollTimer = setInterval(() => {
      const snapshot = snapshotCanvasDir(this.canvasDir);
      if (snapshot !== this.lastSnapshot) {
        this.lastSnapshot = snapshot;
        this.scheduleCanvasChange();
      }
      const sourceSnapshot = snapshotWorkflowSources(this.cwd);
      if (sourceSnapshot !== this.lastSourceSnapshot) {
        this.lastSourceSnapshot = sourceSnapshot;
        this.scheduleSourceChange();
      }
    }, POLL_INTERVAL_MS);
  }

  close(): void {
    this.closed = true;
    if (this.canvasDebounceTimer) clearTimeout(this.canvasDebounceTimer);
    if (this.sourceDebounceTimer) clearTimeout(this.sourceDebounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}

export interface CanvasWatcherManagerDeps {
  /** Debounced per-session notification that the RENDERED canvas output under
   *  `.sapiom/canvas/` changed — the integrator broadcasts
   *  `{type: "canvas.reload", harnessSessionId}` on /ws/events from this. */
  onChange(harnessSessionId: string): void;
  /** Debounced per-session notification that a workflow SOURCE file changed —
   *  the integrator re-renders the session's bound workflow from this (the
   *  render write then flows back through onChange as an iframe reload). */
  onSourceChange(harnessSessionId: string): void;
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
      new SessionCanvasWatcher(cwd, harnessSessionId, {
        onCanvasChange: (id) => this.deps.onChange(id),
        onSourceChange: (id) => this.deps.onSourceChange(id),
      }),
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
