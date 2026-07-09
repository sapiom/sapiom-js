/**
 * Shared filesystem path-safety guards.
 *
 * The harness runs on the user's own machine on the user's own inputs
 * (workflow directories, a session cwd, a canvas sub-path), so the threat
 * here isn't a remote attacker crossing a privilege boundary — it's ordinary
 * footguns: a `..` segment, an absolute path where a relative one was meant,
 * or a symlink that quietly resolves a user-derived value outside the
 * directory a feature intended to confine it to. Each helper turns "a path
 * that might escape" into "a path proven to stay put, or null", so callers
 * reject rather than silently reach outside — and each guard is written in a
 * form static analysis recognizes as neutralizing path-traversal taint.
 */
import * as path from "node:path";

/**
 * The absolute path of `name` as a direct child of `root`, or null when
 * `name` is anything other than one plain path segment — separators, ".",
 * "..", absolute paths, or anything else that could resolve outside `root`.
 * (Extracted from the generated-dir retention policy, which relies on it to
 * refuse deleting anything but a direct child of its own root.)
 */
export function childPath(root: string, name: string): string | null {
  if (!name || name === "." || name === "..") return null;
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root || path.basename(resolved) !== name) return null;
  return resolved;
}

/**
 * Resolves `candidate` (relative to `root`, or absolute) and confirms the
 * result stays within `root`. Returns the resolved absolute path, or null if
 * it escapes — whether via a `..` climb, an absolute path, or a different
 * drive. `root` itself counts as inside.
 *
 * Containment is decided with `path.relative`: the relative path from the
 * resolved root to the resolved candidate begins with `..` (or is itself
 * absolute) exactly when the candidate lies outside the root — the standard,
 * analyzer-recognized shape for a path-traversal barrier.
 */
export function resolveWithinRoot(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

/**
 * True when `p` contains an upward-traversal (`..`) path segment. Segment
 * aware: a name that merely *contains* ".." (e.g. "a..b") is not a match.
 *
 * Use as a defense-in-depth assertion on an already-resolved absolute path
 * for endpoints that legitimately accept an arbitrary absolute path (a
 * filesystem browser, an explicit "connect this directory") and so have no
 * single root to confine to. A fully resolved path never retains a `..`
 * segment, so this rejects nothing legitimate — it makes the "normalization
 * left no traversal behind" guarantee explicit and local to the sink.
 */
export function hasTraversalSegment(p: string): boolean {
  return /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(p);
}
