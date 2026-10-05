/**
 * The shell's answers about projects, read from one state snapshot: which open
 * root a project id names, what it is called, which agents it holds, and where
 * a session for an agent boots. Pure, so the rail, the project view and every
 * session and verb door resolve them the same way.
 */
import type { AppState, HarnessSession, WorkflowInfo } from "@shared/types";
import type { StudioProjectId } from "@sapiom/agent-map";

import { studioScopeForAgent } from "./agent-map";
import { basenameOf, samePath } from "./paths";
import { agentBelongsToProjectRoot } from "./project-tree";
import { projectRootForAgent } from "./session-scope";

/**
 * The roots this install knows it has opened: the fallback answer to "where
 * does a session for this agent boot" when no server scope owns the agent.
 *
 * `launchDir` is included because a first boot records the launch directory
 * before `recentDirs` has it, and that is exactly the session whose cwd
 * matters most. Session cwds are deliberately NOT roots: a session an older
 * build left rooted in an agent's own folder would then be the longest "root"
 * containing that agent, and SAP-2927's bug would resolve itself straight back
 * into place. There is no default parent for new agents any more (Q8): an
 * agent is created inside a project the user opened, so nothing here has to
 * guess at one.
 */
export const knownRootsOf = (
  recentDirs: readonly string[] | undefined,
  launchDir: string | null | undefined,
): string[] => [...(recentDirs ?? []), ...(launchDir ? [launchDir] : [])];

/**
 * The project an agent's map lives in: the scope that owns it by its
 * server-issued binding, else the most specific open root containing it. Null
 * for an agent outside every open project, which is on no map.
 */
export const projectIdForAgent = (
  agentPath: string,
  state: Pick<AppState, "workflows" | "workspaceScopes" | "studioProjects"> | null | undefined,
): StudioProjectId | null => {
  if (!state) return null;
  const workflow = state.workflows.find((candidate) =>
    samePath(candidate.path, agentPath),
  );
  if (!workflow) return null;
  const scopes = state.workspaceScopes ?? [];
  // A server without durable Studio projects still issues each scope an id:
  // the longest open root that holds the agent, under the rule the rail used
  // to file agents by.
  return (
    studioScopeForAgent(workflow, scopes, state.studioProjects ?? [])
      ?.projectId ??
    scopes
      .filter((scope) => agentBelongsToProjectRoot(workflow, scope.cwd, scopes))
      .sort((a, b) => b.cwd.length - a.cwd.length)[0]?.projectId ??
    null
  );
};

/** The project lookups over one state snapshot. */
export const shellProjects = (
  state: AppState,
  recentDirs: readonly string[] | undefined,
) => {
  const workspaceScopes = state.workspaceScopes ?? [];
  /** The roots this install knows it has opened — see `knownRootsOf`. */
  const knownProjectRoots = (): string[] =>
    knownRootsOf(recentDirs, state.launchDir);
  /** The open root a project id names, if the rail has it. */
  const projectScope = (projectId: string) =>
    workspaceScopes.find((scope) => scope.projectId === projectId) ?? null;
  const projectLabelOf = (projectId: string): string => {
    const scope = projectScope(projectId);
    return (
      state.studioProjects?.find((project) => project.projectId === projectId)
        ?.displayName ||
      (scope ? basenameOf(scope.cwd) : "Project")
    );
  };
  /** A project's agents, under the rule the old rail filed them by. */
  const agentsInProject = (projectId: string): WorkflowInfo[] => {
    const scope = projectScope(projectId);
    return scope
      ? state.workflows.filter((workflow) =>
          agentBelongsToProjectRoot(workflow, scope.cwd, workspaceScopes),
        )
      : [];
  };
  /** The root a session belongs to: its project's open root, else the longest
   *  known root containing its cwd. */
  const sessionRoot = (session: HarnessSession): string =>
    projectScope(session.agentMapIdentity?.projectId ?? "")?.cwd ??
    projectRootForAgent(session.cwd, knownProjectRoots());
  /**
   * The ONE answer to "where does a session for this agent boot" (SAP-2927):
   * the root of the project that owns it, never the agent's own folder, so the
   * coding agent comes up with the project's CLAUDE.md, .claude/ and skills.
   * The paths that create a session for a BRAND-NEW project folder (scaffold,
   * templates, the composer, a deep-link clone) deliberately do not come
   * through here: that folder is the new project's root by construction.
   */
  const sessionCwdForAgent = (agentPath: string): string => {
    const projectId = projectIdForAgent(agentPath, state);
    return (
      (projectId ? projectScope(projectId)?.cwd : undefined) ??
      projectRootForAgent(agentPath, knownProjectRoots())
    );
  };
  return {
    workspaceScopes,
    projectScope,
    projectLabelOf,
    agentsInProject,
    sessionRoot,
    sessionCwdForAgent,
  };
};

export type ShellProjects = ReturnType<typeof shellProjects>;
