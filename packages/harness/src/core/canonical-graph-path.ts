import { realpathSync } from "node:fs";
import * as path from "node:path";

const MAX_CACHED_PATHS = 20_000;
const canonicalPaths = new Map<string, string>();
let probe: ((path: string) => void) | null = null;

function isWindowsAbsolute(input: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(input)
  );
}

function pathApi(input: string): typeof path.posix {
  return isWindowsAbsolute(input) ? path.win32 : path.posix;
}

function normalizedAbsolute(input: string): string {
  const api = pathApi(input);
  return api.resolve(
    isWindowsAbsolute(input) ? input.replace(/\//g, "\\") : input,
  );
}

function remember(key: string, value: string): void {
  canonicalPaths.delete(key);
  canonicalPaths.set(key, value);
  while (canonicalPaths.size > MAX_CACHED_PATHS) {
    const oldest = canonicalPaths.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    canonicalPaths.delete(oldest);
  }
}

/** Seeds canonical evidence produced asynchronously by registry load/scan. */
export function rememberCanonicalGraphPath(
  input: string,
  canonical: string,
): void {
  const key = normalizedAbsolute(input);
  const value = normalizedAbsolute(canonical);
  remember(key, value);
  remember(value, value);
}

/**
 * Canonicalizes an arbitrary graph path. Production registry paths hit the
 * memory cache; the filesystem fallback remains for defensive arbitrary
 * providers and watcher paths that have not yet been reconciled.
 */
export function canonicalGraphPath(input: string): string {
  const windows = isWindowsAbsolute(input);
  const api = pathApi(input);
  const resolved = normalizedAbsolute(input);
  const cached = canonicalPaths.get(resolved);
  if (cached !== undefined) {
    remember(resolved, cached);
    return cached;
  }
  const matchesHost = windows === (process.platform === "win32");
  if (!matchesHost) return resolved;
  let result = resolved;
  try {
    probe?.(resolved);
    result = realpathSync.native(resolved);
  } catch {
    const missingSegments: string[] = [];
    let ancestor = resolved;
    let parent = api.dirname(ancestor);
    while (parent !== ancestor) {
      missingSegments.unshift(api.basename(ancestor));
      ancestor = parent;
      try {
        probe?.(ancestor);
        result = api.join(realpathSync.native(ancestor), ...missingSegments);
        break;
      } catch {
        parent = api.dirname(ancestor);
      }
    }
  }
  rememberCanonicalGraphPath(resolved, result);
  return result;
}

/** Test-only visibility into whether a hot projection touched the filesystem. */
export function setCanonicalGraphPathProbeForTest(
  next: ((path: string) => void) | null,
): void {
  probe = next;
}

export function clearCanonicalGraphPathCacheForTest(): void {
  canonicalPaths.clear();
  probe = null;
}
