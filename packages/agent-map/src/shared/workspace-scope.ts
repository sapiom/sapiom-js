/** Browser-safe workspace scope metadata and relative source identities. */
export type WorkspaceKey = string;

export interface WorkspaceScopeSummary {
  workspaceKey: WorkspaceKey;
  /** Used only to join the existing workspace-folder projection in AppState. */
  cwd: string;
  /** Durable Agent Map identity joined server-side; distinct from the scope key. */
  projectId?: import("./agent-map.js").StudioProjectId;
}
