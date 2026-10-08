import { isWithinDir, pathComparisonKey, pathSegmentDepth } from "./paths.js";
/** Use locale-independent ordering for deterministic root selection. */
const lexicalCompare = (a: string, b: string): number =>
  a === b ? 0 : a < b ? -1 : 1;

/** Lexical normalization only; filesystem identity is resolved by the host. */
function normalizedPath(input: string): string {
  const path = input.replace(/\\/g, "/");
  // Keep a drive or UNC server/share together so `..` cannot leave its root.
  const prefix =
    path.match(/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/)?.[0] ?? "";
  const segments: string[] = [];
  for (const segment of path.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (
      segment === ".." &&
      segments.length &&
      segments[segments.length - 1] !== ".."
    ) {
      segments.pop();
    } else if (segment !== ".." || !prefix) {
      segments.push(segment);
    }
  }
  return pathComparisonKey(prefix + segments.join("/"));
}

export interface DurableProjectRoot {
  projectId: string;
  cwd: string;
}

/**
 * Resolve the most-specific containing durable root with one deterministic
 * browser/server rule. Equal-specificity claims by different projects fail
 * closed; multiple bindings owned by one durable project remain valid.
 */
export function matchProjectRootForPath<T extends DurableProjectRoot>(
  targetPath: string,
  roots: readonly T[],
): ProjectRootMatch<T> {
  const target = normalizedPath(targetPath);
  const matches = roots
    .map((root) => ({ root, path: normalizedPath(root.cwd) }))
    .filter(({ path }) => isWithinDir(path, target));
  if (matches.length === 0) return { kind: "unregistered" };
  const depth = Math.max(...matches.map(({ path }) => pathSegmentDepth(path)));
  const nearest = matches.filter(
    ({ path }) => pathSegmentDepth(path) === depth,
  );
  const projectIds = [
    ...new Set(nearest.map(({ root }) => root.projectId)),
  ].sort();
  if (projectIds.length !== 1) return { kind: "ambiguous", projectIds };
  return {
    kind: "resolved",
    root: [...nearest].sort(
      (left, right) =>
        lexicalCompare(left.path, right.path) ||
        lexicalCompare(left.root.cwd, right.root.cwd),
    )[0]!.root,
  };
}

export type ProjectRootMatch<T> =
  | { kind: "resolved"; root: T }
  | { kind: "unregistered" }
  | { kind: "ambiguous"; projectIds: string[] };

/** Compatibility wrapper returning null for missing or ambiguous project roots. */
export function resolveProjectRootForPath<T extends DurableProjectRoot>(
  targetPath: string,
  roots: readonly T[],
): T | null {
  const match = matchProjectRootForPath(targetPath, roots);
  return match.kind === "resolved" ? match.root : null;
}
