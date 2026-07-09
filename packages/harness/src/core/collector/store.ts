/**
 * Append-only local sink for analytics events. Always written, regardless
 * of telemetry opt-in — this is the "demo inspects this" local debug file,
 * independent of whether anything gets batched to a remote collector.
 *
 * Concurrency: every append is serialized through a promise queue (the same
 * pattern as workflow-registry.ts and session-manager.ts). `runExclusive(fn)`
 * chains `fn` onto the same queue so retention sweeps (read→filter→rename)
 * never overlap with an in-flight append and no appended line can be lost
 * in a sweep's read window. Overhead is negligible — appends are low-frequency
 * (one per hook event), and the queue never holds more than O(sessions) entries.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { HARNESS_PATHS, type AnalyticsEvent } from "../../shared/types.js";
import { expandHome } from "../paths.js";

export interface EventStore {
  /** Append one event as a single ndjson line, serialized through the queue. */
  append(event: AnalyticsEvent): Promise<void>;
  /**
   * Run `fn` exclusively — after all pending appends complete and blocking
   * any new appends until `fn` resolves. Use this to run a retention sweep
   * without racing concurrent writes.
   *
   * A failed `fn` never poisons the queue (later appends proceed normally).
   * The return value of `fn` is forwarded to the caller.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * @param filePath Defaults to `HARNESS_PATHS.events`
 *   (`~/.sapiom/harness/events.ndjson`). Override in tests.
 */
export function createEventStore(filePath: string = HARNESS_PATHS.events): EventStore {
  const resolvedPath = expandHome(filePath);
  let dirReady: Promise<void> | null = null;

  function ensureDir(): Promise<void> {
    if (!dirReady) {
      dirReady = fs.mkdir(path.dirname(resolvedPath), { recursive: true }).then(() => undefined);
    }
    return dirReady;
  }

  // Promise queue — same pattern as workflow-registry.ts:106-135.
  // Chains each operation so they execute strictly one-at-a-time.
  // A failed run never poisons subsequent operations.
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => {}).then(run);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  return {
    append(event: AnalyticsEvent): Promise<void> {
      return enqueue(async () => {
        await ensureDir();
        await fs.appendFile(resolvedPath, `${JSON.stringify(event)}\n`, "utf8");
      });
    },

    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      return enqueue(fn);
    },
  };
}
