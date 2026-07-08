/**
 * Append-only local sink for analytics events. Always written, regardless
 * of telemetry opt-in — this is the "demo inspects this" local debug file,
 * independent of whether anything gets batched to a remote collector.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { HARNESS_PATHS, type AnalyticsEvent } from "../../shared/types.js";
import { expandHome } from "../paths.js";

export interface EventStore {
  /** Append one event as a single ndjson line. Crash-safe (fs.appendFile). */
  append(event: AnalyticsEvent): Promise<void>;
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

  return {
    async append(event: AnalyticsEvent): Promise<void> {
      await ensureDir();
      await fs.appendFile(resolvedPath, `${JSON.stringify(event)}\n`, "utf8");
    },
  };
}
