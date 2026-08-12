/**
 * Canonicalize a client-supplied working directory before it touches anything.
 *
 * The SPA builds project paths in the browser, where it cannot know the host's
 * separator — a Windows root joined with "/" produced mixed-separator paths
 * like `C:\Users\x\.sapiom\harness\projects/newsletter-autopilot` that were
 * then used verbatim as the pty cwd, persisted to sessions.json, and compared
 * against `path.join`ed server paths with `startsWith`. The client-side join is
 * fixed too (web/src/lib/paths.ts), but the server must not depend on every
 * client getting it right: one `resolve()` here collapses separators and `..`
 * segments for every entry point.
 *
 * The platform's path implementation is injected so the Windows behavior is
 * provable from POSIX CI — same pattern as core/spawn-target.ts.
 */
import path, { type PlatformPath } from "node:path";

export function normalizeCwd(cwd: string, pathImpl: PlatformPath = path): string {
  const trimmed = cwd.trim();
  if (!trimmed) return trimmed;
  return pathImpl.resolve(trimmed);
}
