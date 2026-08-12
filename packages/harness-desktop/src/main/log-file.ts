/**
 * Tee `console.log/warn/error` into a file.
 *
 * The packaged Windows app is a GUI-subsystem exe: there is no console, so
 * every `console.error` — including the harness server's
 * `[harness] unhandled request error:` lines, which run in this same process —
 * simply vanishes, and a user with a broken install has nothing to send us.
 * This wraps the console methods to append a formatted copy of each line to
 * `main.log` while still calling the original (stdout/stderr keep working for
 * `pnpm dev`, `--smoke`, and terminal launches).
 *
 * No `electron` import — the caller passes the resolved log path — so the pure
 * pieces (`formatLogLine`, `shouldRotate`) and even `initFileLog` itself are
 * unit-testable (see vitest.config.ts and the update-policy.ts/updater.ts
 * split this mirrors).
 *
 * Logging must NEVER take the app down: every filesystem/stream operation is
 * individually try/caught, and a failure just means we log less.
 */
import { createWriteStream, mkdirSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import * as path from "node:path";
import * as util from "node:util";

/** Boot-time rotation threshold: past this, the old log is discarded. */
export const LOG_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;

/** Should a log file of `sizeBytes` be truncated before appending? */
export function shouldRotate(sizeBytes: number): boolean {
  return sizeBytes > LOG_SIZE_LIMIT_BYTES;
}

/** One log line: `[<ISO timestamp>] [<level>] <util.format(...args)>\n`. */
export function formatLogLine(level: string, args: unknown[], now: Date): string {
  return `[${now.toISOString()}] [${level}] ${util.format(...args)}\n`;
}

const LEVELS = ["log", "warn", "error"] as const;

let initialized = false;

/**
 * Open (append) the log file at `logPath` and wrap the console methods to tee
 * into it. Idempotent — a second call is a no-op, so the console is never
 * double-wrapped. If the file exceeds the size limit at boot, it is truncated
 * first (whole-file discard: the simplest rotation that can't fail halfway).
 */
export function initFileLog(logPath: string, appVersion: string): void {
  if (initialized) return;
  initialized = true;

  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    /* unwritable dir — carry on, the stream open below will just fail too */
  }

  try {
    if (shouldRotate(statSync(logPath).size)) writeFileSync(logPath, "");
  } catch {
    /* file absent (the common case) or unstat-able — nothing to rotate */
  }

  let stream: WriteStream;
  try {
    stream = createWriteStream(logPath, { flags: "a" });
    // A later stream error (disk full, file deleted) must not become an
    // uncaught 'error' event that kills the process.
    stream.on("error", () => {});
  } catch {
    return; // no file logging on this machine; the console still works
  }

  const tee = (level: string, args: unknown[]): void => {
    try {
      stream.write(formatLogLine(level, args, new Date()));
    } catch {
      /* never let logging throw into the caller */
    }
  };

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      tee(level, args);
      original(...args);
    };
  }

  console.log(`[harness-desktop] v${appVersion} ${process.platform} ${process.arch}`);
}
