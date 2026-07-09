/**
 * Retention cap enforcement for the local analytics sink (events.ndjson).
 *
 * Policy (enforced on server boot and periodically afterwards):
 *   - Size cap: 50 MB — truncate to the newest events that fit.
 *   - Age cap: 30 days — drop events older than this by their `ts` field.
 *   The stricter of the two wins; oldest-first truncation always preserves
 *   the newest events.
 *
 * Atomicity: rewrites happen via a temp-file rename so a crash mid-write
 * never leaves a corrupt or empty events file. The write path must be in
 * the same directory (same filesystem partition) as the target so rename()
 * is atomic.
 *
 * Concurrency: callers MUST run sweepNdjson() through EventStore.runExclusive()
 * so the sweep's read→filter→rename window never races a concurrent append.
 * The store serializes all appends through a promise queue; runExclusive()
 * chains the sweep onto that same queue, guaranteeing mutual exclusion.
 * See store.ts and server/index.ts for the wiring.
 *
 * Corruption tolerance: lines that fail JSON.parse are silently kept rather
 * than aborting the sweep — a single bad line never blocks retention.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** 50 MB default size cap. */
export const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
/** 30 days default age cap. */
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SweepOptions {
  maxSizeBytes?: number;
  maxAgeMs?: number;
}

export interface SweepResult {
  /** Number of lines in the file before the sweep. */
  linesBefore: number;
  /** Number of lines retained after the sweep. */
  linesAfter: number;
  /** True when the file was actually rewritten (something was trimmed). */
  rewritten: boolean;
}

/**
 * Enforces size and age caps on an ndjson file, retaining the newest events.
 *
 * Returns a SweepResult describing what happened. Never throws on ENOENT
 * (the file doesn't exist yet — that's fine). Propagates other I/O errors
 * to the caller.
 *
 * IMPORTANT: callers must run this through EventStore.runExclusive() to
 * prevent races with concurrent appends (see module-level docstring).
 */
export async function sweepNdjson(
  filePath: string,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cutoffMs = Date.now() - maxAgeMs;

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { linesBefore: 0, linesAfter: 0, rewritten: false };
    }
    throw err;
  }

  const rawLines = content.split("\n");
  // Last line is often empty (trailing newline) — exclude it from the count.
  const lines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  const linesBefore = lines.length;

  // Filter by age first — drop lines whose `ts` field is older than the cap.
  // Lines that fail JSON.parse are kept (corrupted lines fall through the age
  // filter; the size cap below may still drop them if needed).
  const ageFiltered = lines.filter((line) => {
    try {
      const parsed = JSON.parse(line) as { ts?: unknown };
      if (typeof parsed.ts !== "string") return true; // keep if no ts
      const lineMs = Date.parse(parsed.ts);
      return !Number.isNaN(lineMs) && lineMs >= cutoffMs;
    } catch {
      return true; // keep on parse failure
    }
  });

  // Size cap: O(n) cumulative-bytes pass — compute the byte length of each
  // line (with its trailing newline), accumulate from the BACK (newest first),
  // and find the earliest index that still fits in maxSizeBytes. Avoids the
  // O(n²) cost of re-joining the entire array on each iteration.
  let dropCount = 0;
  if (ageFiltered.length > 0) {
    // Total byte count of all age-filtered lines.
    const lineLengths = ageFiltered.map((line) => Buffer.byteLength(line + "\n", "utf8"));
    const total = lineLengths.reduce((sum, n) => sum + n, 0);

    if (total > maxSizeBytes) {
      // Walk from the front, accumulating bytes to drop until the remaining
      // content (total − dropped) fits within the cap.
      let dropped = 0;
      for (let i = 0; i < ageFiltered.length; i++) {
        if (total - dropped <= maxSizeBytes) break;
        dropped += lineLengths[i];
        dropCount = i + 1;
      }
    }
  }
  const kept = dropCount > 0 ? ageFiltered.slice(dropCount) : ageFiltered;

  const linesAfter = kept.length;
  const nothingChanged = linesAfter === linesBefore;
  if (nothingChanged) {
    return { linesBefore, linesAfter, rewritten: false };
  }

  // Atomic rewrite via temp file + rename. Both must be on the same filesystem
  // (same directory) for the rename to be atomic.
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.events-retention-tmp-${process.pid}-${Date.now()}.ndjson`);
  try {
    const newContent = kept.length === 0 ? "" : kept.join("\n") + "\n";
    await fs.writeFile(tmpPath, newContent, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file; the rename failure is what matters.
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return { linesBefore, linesAfter, rewritten: true };
}
