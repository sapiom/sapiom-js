import * as path from "node:path";
import { canonicalGraphPath } from "./canonical-graph-path.js";

function isWindowsAbsolute(input: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(input)
  );
}

function pathApi(input: string): typeof path.posix {
  return isWindowsAbsolute(input) ? path.win32 : path.posix;
}

export function isWithinWorkspacePath(root: string, candidate: string): boolean {
  if (isWindowsAbsolute(root) !== isWindowsAbsolute(candidate)) return false;
  const api = pathApi(root);
  const relative = api.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${api.sep}`) &&
      !api.isAbsolute(relative))
  );
}

/** Canonical registered roots contained by a workspace, safe for symlinked scopes. */
export function sourceRootsWithinScope(
  scopeRoot: string,
  sourceRoots: readonly string[],
): string[] {
  const canonicalScopeRoot = canonicalGraphPath(scopeRoot);
  return [
    ...new Set(
      sourceRoots
        .map(canonicalGraphPath)
        .filter((sourceRoot) =>
          isWithinWorkspacePath(canonicalScopeRoot, sourceRoot),
        ),
    ),
  ].sort();
}

