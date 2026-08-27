/**
 * Public contract for the local workspace dependency graph. Graph payloads
 * never carry filesystem roots; WorkspaceScopeSummary only joins AppState's
 * existing cwd-backed folder projection to an opaque key.
 */
export type WorkspaceKey = string;
export type AgentKey = string;

interface ParsedGraphPath {
  caseInsensitive: boolean;
  root: string;
  segments: string[];
}

function normalizedGraphSegments(value: string): string[] | null {
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
function parseGraphPath(input: string): ParsedGraphPath | null {
  const normalized = input.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):\//.exec(normalized);
  if (drive) {
    const segments = normalizedGraphSegments(normalized.slice(drive[0].length));
    return segments
      ? {
          caseInsensitive: true,
          root: `drive:${drive[1]!.toLowerCase()}`,
          segments,
        }
      : null;
  }
  if (normalized.startsWith("//")) {
    const parts = normalizedGraphSegments(normalized.slice(2));
    if (!parts || parts.length < 2) return null;
    return {
      caseInsensitive: true,
      root: `unc:${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`,
      segments: parts.slice(2),
    };
  }
  if (!normalized.startsWith("/")) return null;
  const segments = normalizedGraphSegments(normalized.slice(1));
  return segments
    ? { caseInsensitive: false, root: "posix:/", segments }
    : null;
}

/**
 * The one browser/server rule for a workspace-relative local AgentKey.
 * Callers receive null when the source is not inside the supplied scope.
 */
export function workspaceRelativeLocalKey(
  scopeRoot: string,
  sourceRoot: string,
): AgentKey | null {
  const scope = parseGraphPath(scopeRoot);
  const source = parseGraphPath(sourceRoot);
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
  const local = relative.join("/") || source.segments.at(-1) || "root";
  return `local:${local}`;
}

/** Internal HTTP metadata; it is deliberately not part of SystemGraph JSON. */
export const SYSTEM_GRAPH_CACHE_HEADER = "X-Sapiom-System-Graph-Cache";
export type SystemGraphCacheStatus = "complete" | "degraded";

export interface WorkspaceScopeSummary {
  workspaceKey: WorkspaceKey;
  /** Used only to join the existing workspace-folder projection in AppState. */
  cwd: string;
}

export interface SystemGraphNode {
  id: string;
  agentKey: AgentKey;
  label: string;
}

export type AgentInvocationMode = "blocking" | "async";

export interface SystemGraphEdge {
  from: string;
  to: string;
  kind: "invokes";
  basis: "static";
  mode: AgentInvocationMode;
}

export interface GraphWarning {
  code:
    | "unresolved-target"
    | "dynamic-target"
    | "duplicate-edge"
    | "projection-failed"
    | "duplicate-agent-key"
    | "inventory-extraction-failed";
  message: string;
  agentKey?: AgentKey;
}

export interface SystemGraph {
  kind: "system";
  scope: {
    kind: "working-tree";
    workspaceKey: WorkspaceKey;
  };
  nodes: SystemGraphNode[];
  edges: SystemGraphEdge[];
  warnings: GraphWarning[];
}
export type SystemGraphLifecycleState =
  | "building"
  | "ready"
  | "stale"
  | "degraded";

/** Path-free lifecycle envelope for one workspace projection. */
export interface SystemGraphSnapshot {
  workspaceKey: WorkspaceKey;
  /** Monotonic within one server process and workspace. */
  revision: number;
  state: SystemGraphLifecycleState;
  /** Null only before a usable projection exists. */
  graph: SystemGraph | null;
}
