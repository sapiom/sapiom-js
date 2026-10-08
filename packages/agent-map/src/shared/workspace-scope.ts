/** Browser-safe workspace scope metadata and relative source identities. */
export type WorkspaceKey = string;

/** A live workspace root before the catalog has joined its project identity. */
export interface WorkspaceScopeInput {
  workspaceKey: WorkspaceKey;
  /** Used only to join the existing workspace-folder projection in AppState. */
  cwd: string;
}

/** Every scope the server publishes carries the project that owns its root. */
export interface WorkspaceScopeSummary extends WorkspaceScopeInput {
  /** Durable Agent Map identity joined server-side; distinct from the scope key. */
  projectId: import("./agent-map.js").StudioProjectId;
}
