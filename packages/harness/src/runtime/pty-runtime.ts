import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import { PtyUnavailableError, UnknownSessionError } from "./errors.js";
import type {
  SessionCreateOptions,
  SessionHandle,
  SessionRuntime,
} from "./session-runtime.js";

type NodePtyModule = typeof import("node-pty");

/**
 * Load node-pty lazily so that requiring this package never crashes on a
 * machine where the native addon is missing or broken — the failure is
 * deferred to `create()` and surfaced as a typed `PtyUnavailableError`.
 * Not memoized: module resolution is cached by Node anyway, and a transient
 * failure (e.g. an addon rebuilt mid-session) should not be cached forever.
 */
async function loadNodePty(): Promise<NodePtyModule> {
  try {
    const nodePty = await import("node-pty");
    ensureSpawnHelperExecutable();
    return nodePty;
  } catch (cause) {
    throw new PtyUnavailableError(cause);
  }
}

/**
 * Published node-pty prebuilds (e.g. 1.1.0 on macOS) ship their
 * `spawn-helper` binary without the executable bit — npm tarballs preserve
 * file modes — so every spawn fails with `posix_spawnp failed`. Repair it
 * best-effort before spawning. No-ops when node-pty was compiled from
 * source (no prebuild helper on disk, e.g. Linux) and on Windows (no
 * spawn-helper at all). Runs per create(): it is two stat calls and
 * self-heals if the package is ever re-extracted.
 */
/**
 * The path of this module file in both build flavors: `__filename` in the
 * CJS build; `import.meta.url` in the ESM build. `import.meta` is ESM-only
 * syntax that the CJS compilation would reject, so it is reached through an
 * indirect eval — evaluated only at runtime, only in the ESM build.
 */
function moduleBaseFile(): string | null {
  if (typeof __filename !== "undefined") return __filename;
  try {
    // eslint-disable-next-line no-eval
    return fileURLToPath((0, eval)("import.meta.url") as string);
  } catch {
    return null;
  }
}

/** Exported for unit tests only. @internal */
export function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;

  let helperPath: string;
  try {
    // Resolve node-pty's install location relative to this module so the
    // repair works from both builds regardless of the caller's cwd.
    const base = moduleBaseFile();
    if (base === null) return; // location unknown — nothing to repair
    const req = createRequire(base);
    const entry = req.resolve("node-pty"); // …/node-pty/lib/index.js
    helperPath = path.join(
      path.dirname(entry),
      "..",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
  } catch {
    return; // node-pty location unknown — nothing to repair
  }

  try {
    if (!fs.existsSync(helperPath)) return; // built from source — fine as-is
    fs.accessSync(helperPath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(helperPath, 0o755);
    } catch {
      // Best-effort only: if this fails the spawn itself will fail loudly,
      // and the doctor can point at the helper file.
    }
  }
}

/**
 * Per-session bookkeeping. On exit the entry becomes a tiny tombstone —
 * the pty (native handle) and data listeners are released, but the record
 * stays so once-valid handles keep answering `isAlive() === false` instead
 * of throwing {@link UnknownSessionError}.
 */
interface PtySessionState {
  pty: IPty | null;
  alive: boolean;
  /** Set by the first kill() so concurrent kills don't re-signal. */
  killing: boolean;
  /** Resolves once the process has actually exited. */
  readonly exited: Promise<void>;
  readonly dataListeners: Set<(chunk: Buffer) => void>;
}

/** Options for {@link PtyRuntime}. */
export interface PtyRuntimeOptions {
  /**
   * How long `kill()` waits after SIGTERM before escalating to SIGKILL.
   * Default: 5000 ms.
   */
  killTimeoutMs?: number;
  /** Terminal name advertised to the child (default: `xterm-256color`). */
  terminalName?: string;
}

const DEFAULT_KILL_TIMEOUT_MS = 5_000;

/**
 * The v1 {@link SessionRuntime}: real pseudo-terminals via node-pty.
 *
 * - `create()` spawns `command args…` inside a fresh pty with the given
 *   env/cwd/size. node-pty is imported lazily; if its native addon cannot be
 *   loaded the returned promise rejects with {@link PtyUnavailableError}.
 * - `kill()` is graceful: SIGTERM, then SIGKILL after `killTimeoutMs`.
 * - Handles remain queryable after exit (`isAlive` → false); methods called
 *   with a handle this runtime never issued throw {@link UnknownSessionError}.
 */
export class PtyRuntime implements SessionRuntime {
  private readonly sessions = new Map<string, PtySessionState>();
  private readonly killTimeoutMs: number;
  private readonly terminalName: string;

  constructor(options: PtyRuntimeOptions = {}) {
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    this.terminalName = options.terminalName ?? "xterm-256color";
  }

  async create(opts: SessionCreateOptions): Promise<SessionHandle> {
    const nodePty = await loadNodePty();

    const pty = nodePty.spawn(opts.command, opts.args, {
      name: this.terminalName,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });

    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });

    const state: PtySessionState = {
      pty,
      alive: true,
      killing: false,
      exited,
      dataListeners: new Set(),
    };

    pty.onData((data: string) => {
      if (state.dataListeners.size === 0) return;
      const chunk = Buffer.from(data, "utf8");
      for (const listener of state.dataListeners) {
        listener(chunk);
      }
    });

    pty.onExit(() => {
      state.alive = false;
      // Tombstone: release the native pty handle and listener closures so a
      // long-lived runtime doesn't accumulate them across many sessions.
      state.pty = null;
      state.dataListeners.clear();
      markExited();
    });

    const handle: SessionHandle = { id: `pty-${randomUUID()}` };
    this.sessions.set(handle.id, state);
    return handle;
  }

  write(h: SessionHandle, data: string): void {
    const state = this.getState(h);
    // Racing an exiting agent is normal (user hits Enter as it dies);
    // dropping the write mirrors what a real terminal would do.
    if (!state.alive || state.pty === null) return;
    state.pty.write(data);
  }

  onData(h: SessionHandle, cb: (chunk: Buffer) => void): () => void {
    const state = this.getState(h);
    state.dataListeners.add(cb);
    return () => {
      state.dataListeners.delete(cb);
    };
  }

  resize(h: SessionHandle, cols: number, rows: number): void {
    const state = this.getState(h);
    if (!state.alive || state.pty === null) return;
    try {
      state.pty.resize(cols, rows);
    } catch (error) {
      // The process can exit between the aliveness check and the ioctl;
      // resizing a dead session is a no-op, not an error.
      if (state.alive) throw error;
    }
  }

  async kill(h: SessionHandle): Promise<void> {
    const state = this.getState(h);
    if (!state.alive) return;
    if (state.killing) {
      // A concurrent kill() already owns the escalation; just wait with it.
      await state.exited;
      return;
    }
    state.killing = true;

    this.signal(state, "SIGTERM");
    const exitedInTime = await this.waitForExit(state, this.killTimeoutMs);
    if (!exitedInTime) {
      this.signal(state, "SIGKILL");
      await state.exited;
    }
  }

  isAlive(h: SessionHandle): boolean {
    return this.sessions.get(h.id)?.alive ?? false;
  }

  private getState(h: SessionHandle): PtySessionState {
    const state = this.sessions.get(h.id);
    if (!state) throw new UnknownSessionError(h.id);
    return state;
  }

  private signal(state: PtySessionState, signal: "SIGTERM" | "SIGKILL"): void {
    if (state.pty === null) return; // already exited and tombstoned
    try {
      if (process.platform === "win32") {
        // Signals are not supported on Windows; kill() closes the pty.
        state.pty.kill();
      } else {
        state.pty.kill(signal);
      }
    } catch {
      // The process may already be gone — that's what we wanted.
    }
  }

  /** Resolve true when the session exits within `timeoutMs`, else false. */
  private waitForExit(
    state: PtySessionState,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void state.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
