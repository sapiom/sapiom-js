import { createHash } from "node:crypto";
import type { WorkspaceKey, WorkspaceScopeSummary } from "../shared/workspace-scope.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";

export interface WorkspaceScope {
  workspaceKey: WorkspaceKey;
  root: string;
}

export interface WorkspaceScopeResolver {
  resolve(workspaceKey: WorkspaceKey): Promise<WorkspaceScope | null>;
}

export interface WorkspaceScopeCatalog extends WorkspaceScopeResolver {
  list(): Promise<WorkspaceScopeSummary[]>;
}

function workspaceKeyForRoot(root: string): WorkspaceKey {
  return `workspace-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/**
 * Resolves only roots the running Studio already knows about. A caller cannot
 * manufacture a key and resolve an arbitrary filesystem path.
 */
export class LocalWorkspaceScopeCatalog implements WorkspaceScopeCatalog {
  constructor(
    private readonly listRoots: () =>
      | readonly string[]
      | Promise<readonly string[]>,
  ) {}

  async list(): Promise<WorkspaceScopeSummary[]> {
    const byRoot = new Map<string, WorkspaceScopeSummary>();
    for (const root of await this.listRoots()) {
      const canonical = canonicalGraphPath(root);
      byRoot.set(canonical, {
        workspaceKey: workspaceKeyForRoot(canonical),
        cwd: root,
      });
    }
    return [...byRoot.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, summary]) => summary);
  }

  async resolve(workspaceKey: WorkspaceKey): Promise<WorkspaceScope | null> {
    for (const root of await this.listRoots()) {
      const canonical = canonicalGraphPath(root);
      if (workspaceKeyForRoot(canonical) === workspaceKey) {
        return { workspaceKey, root: canonical };
      }
    }
    return null;
  }
}

