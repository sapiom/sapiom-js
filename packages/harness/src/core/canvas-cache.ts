/**
 * In-memory extraction cache: binding an unchanged workflow must never pay
 * for a child `check()` process twice. Keyed by workflow directory, guarded
 * by a cheap source fingerprint (file count + newest mtime over the
 * project's own `.ts`/`.tsx` sources — the same file walk the launch grep
 * uses, see core/canvas-interconnections.ts's `listSourceFiles`). Any source
 * edit bumps an mtime, any add/remove changes the count; either invalidates.
 *
 * Only SUCCESSFUL extractions are cached: a failure like "run npm install
 * first" gets fixed without touching any `.ts` file, so a cached failure
 * would never self-invalidate — re-running the (already fast-failing)
 * extraction is the honest choice there.
 *
 * Process-lifetime only; a server restart re-extracts once per workflow.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractWorkflowGraph, type ExtractionResult, type ExtractionSuccess } from "./canvas-graph.js";
import { listSourceFiles } from "./canvas-interconnections.js";

/** `<file count>:<newest mtimeMs>` over the workflow's own sources. */
export async function fingerprintWorkflowSources(root: string): Promise<string> {
  const files = await listSourceFiles(root);
  let maxMtimeMs = 0;
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs > maxMtimeMs) maxMtimeMs = stat.mtimeMs;
    } catch {
      // A file deleted mid-walk still counts toward the file count; the next
      // fingerprint won't include it, which is invalidation working as intended.
    }
  }
  return `${files.length}:${maxMtimeMs}`;
}

interface CacheEntry {
  fingerprint: string;
  result: ExtractionSuccess;
}

const cache = new Map<string, CacheEntry>();

export interface CachedExtraction {
  result: ExtractionResult;
  /** True when the result came from cache — no child process ran. */
  cached: boolean;
  /** The source fingerprint the result corresponds to — the same value the
   *  enrichment cache stores as `sourceFingerprint`, so freshness checks
   *  compare like with like. */
  fingerprint: string;
}

/**
 * `extractWorkflowGraph` behind the fingerprint cache. The `extract`
 * parameter exists for tests only (inject a spy to prove hit/miss behavior).
 */
export async function extractWorkflowGraphCached(
  sourceDir: string,
  extract: (dir: string) => Promise<ExtractionResult> = extractWorkflowGraph,
): Promise<CachedExtraction> {
  const key = path.resolve(sourceDir);
  const fingerprint = await fingerprintWorkflowSources(key);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint) return { result: hit.result, cached: true, fingerprint };

  const result = await extract(key);
  if (result.ok) cache.set(key, { fingerprint, result });
  else cache.delete(key);
  return { result, cached: false, fingerprint };
}

/** Drops one workflow's cached extraction — the visualize macro's force
 *  refresh, which must re-run the child process even for unchanged sources. */
export function invalidateExtractionCache(sourceDir: string): void {
  cache.delete(path.resolve(sourceDir));
}

/** Test hook — the cache is module-level state shared across a process. */
export function clearExtractionCache(): void {
  cache.clear();
}
