/** Browser-safe workspace scope metadata and relative source identities. */
export type WorkspaceKey = string;

export interface WorkspaceScopeSummary {
  workspaceKey: WorkspaceKey;
  /** Used only to join the existing workspace-folder projection in AppState. */
  cwd: string;
  /** Durable Agent Map identity joined server-side; distinct from the scope key. */
  projectId?: import("./agent-map.js").StudioProjectId;
}

interface ParsedWorkspacePath {
  caseInsensitive: boolean;
  root: string;
  segments: string[];
}

function normalizedWorkspaceSegments(value: string): string[] | null {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Parse the absolute POSIX, drive-letter, and UNC paths that can cross the
 * Harness HTTP boundary without importing Node's `path` module into the SPA.
 */
function parseWorkspacePath(input: string): ParsedWorkspacePath | null {
  const normalized = input.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(normalized);
  if (drive) {
    const segments = normalizedWorkspaceSegments(normalized.slice(drive[0].length));
    return segments
      ? {
          caseInsensitive: true,
          root: `drive:${drive[1]!.toLowerCase()}`,
          segments,
        }
      : null;
  }
  if (normalized.startsWith("//")) {
    const parts = normalizedWorkspaceSegments(normalized.slice(2));
    if (!parts || parts.length < 2) return null;
    return {
      caseInsensitive: true,
      root: `unc:${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`,
      segments: parts.slice(2),
    };
  }
  if (!normalized.startsWith("/")) return null;
  const segments = normalizedWorkspaceSegments(normalized.slice(1));
  return segments
    ? { caseInsensitive: false, root: "posix:/", segments }
    : null;
}

/**
 * The one browser/server rule for a workspace-relative local identity.
 * Callers receive null when the source is not inside the supplied scope.
 */
export function workspaceRelativeLocalKey(
  scopeRoot: string,
  sourceRoot: string,
): string | null {
  const scope = parseWorkspacePath(scopeRoot);
  const source = parseWorkspacePath(sourceRoot);
  if (
    !scope ||
    !source ||
    scope.root !== source.root ||
    scope.caseInsensitive !== source.caseInsensitive ||
    scope.segments.length > source.segments.length
  ) {
    return null;
  }
  const equal = (left: string, right: string): boolean =>
    scope.caseInsensitive
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  if (
    scope.segments.some(
      (segment, index) => !equal(segment, source.segments[index]!),
    )
  ) {
    return null;
  }
  const relative = source.segments.slice(scope.segments.length);
  const local = relative.join("/") || "root";
  return `local:${local}`;
}

