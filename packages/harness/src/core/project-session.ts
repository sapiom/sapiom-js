import type {
  AgentMapWorkspaceState,
  ProjectAgentSession,
  StudioProjectId,
} from "../shared/agent-map.js";
import type { HarnessSession } from "../shared/types.js";
import { isWithinDir } from "../shared/paths.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";
import type { StudioProjectIdentity } from "./studio-project-catalog.js";

export interface FocusedProjectContextDetails {
  confirmedRevision?: {
    digest?: string | null;
    summaries?: readonly string[];
  } | null;
  activeProposal?: {
    status?: string | null;
    summary?: string | null;
  } | null;
  projectBuildPlan?: {
    status?: string | null;
    summary?: string | null;
  } | null;
  warnings?: readonly string[];
}

export function localProjectPrincipal(
  userId: string | null,
  machineId: string,
): string {
  return userId ?? `local:${machineId}`;
}

function isWithinRoot(root: string, candidate: string): boolean {
  if (root.trim() === "" || candidate.trim() === "") return false;
  try {
    return isWithinDir(canonicalGraphPath(root), canonicalGraphPath(candidate));
  } catch {
    return false;
  }
}

/**
 * Whether a session cwd is equal to or descends from a current active project
 * root. Durable project identity remains the authority boundary; containment
 * is an additional server-side launch/resume safety check.
 */
export function isWithinCurrentProject(
  project: StudioProjectIdentity,
  cwd: string,
): boolean {
  return project.rootBindings.some(
    (binding) =>
      binding.status === "active" && isWithinRoot(binding.localRootRef, cwd),
  );
}

function samePrincipal(
  identity: ProjectAgentSession | null | undefined,
  expected: ProjectAgentSession,
): boolean {
  return Boolean(
    identity &&
      identity.projectId === expected.projectId &&
      identity.userId === expected.userId &&
      identity.sessionId === expected.sessionId,
  );
}

export async function isProjectSessionDispatchAuthorized(input: {
  session: HarnessSession;
  currentPrincipal: () => string;
  resolveProject: (
    projectId: StudioProjectId,
  ) => Promise<StudioProjectIdentity | null>;
}): Promise<boolean> {
  const identity = input.session.agentMapIdentity;
  if (!identity || identity.sessionId !== input.session.id) return false;
  const expected: ProjectAgentSession = {
    projectId: identity.projectId,
    sessionId: identity.sessionId,
    userId: identity.userId,
  };
  if (input.currentPrincipal() !== expected.userId) return false;
  let project: StudioProjectIdentity | null;
  try {
    project = await input.resolveProject(expected.projectId);
  } catch {
    return false;
  }
  return Boolean(
    project &&
      input.currentPrincipal() === expected.userId &&
      input.session.id === expected.sessionId &&
      samePrincipal(input.session.agentMapIdentity, expected) &&
      isWithinCurrentProject(project, input.session.cwd),
  );
}

export interface FocusedProjectContextInput {
  project: StudioProjectIdentity;
  workspace: AgentMapWorkspaceState;
  sessionId: string;
  userId: string;
  details?: FocusedProjectContextDetails;
}

/**
 * Path-free, role-neutral project context. It never changes the common prompt,
 * tools, filesystem policy, or implementation authority.
 */
export function buildFocusedProjectContext(
  input: FocusedProjectContextInput,
): string {
  const { project, workspace } = input;
  const bounded = (value: string, max = 256): string => value.slice(0, max);
  const details = input.details ?? {};
  const emptyProject =
    workspace.confirmedRevisionId === null &&
    workspace.activeProposalId === null &&
    workspace.projectBuildPlanId === null;
  const context = {
    identity: {
      projectId: project.projectId,
      sessionId: input.sessionId,
      userId: input.userId,
    },
    project: {
      displayName: bounded(project.displayName),
      empty: emptyProject,
      confirmedRevision: workspace.confirmedRevisionId
        ? {
            id: workspace.confirmedRevisionId,
            digest: details.confirmedRevision?.digest
              ? bounded(details.confirmedRevision.digest, 512)
              : null,
            summaries: (details.confirmedRevision?.summaries ?? [])
              .slice(0, 32)
              .map((summary) => bounded(summary)),
          }
        : null,
      activeProposal: workspace.activeProposalId
        ? {
            id: workspace.activeProposalId,
            status: details.activeProposal?.status
              ? bounded(details.activeProposal.status, 64)
              : null,
            summary: details.activeProposal?.summary
              ? bounded(details.activeProposal.summary)
              : null,
          }
        : null,
      projectBuildPlan: workspace.projectBuildPlanId
        ? {
            id: workspace.projectBuildPlanId,
            status: details.projectBuildPlan?.status
              ? bounded(details.projectBuildPlan.status, 64)
              : null,
            summary: details.projectBuildPlan?.summary
              ? bounded(details.projectBuildPlan.summary)
              : null,
          }
        : null,
      bindingRefs: project.rootBindings
        .slice(0, 64)
        .map(({ id, repositoryId, status }) => ({
          id: bounded(id),
          repositoryId: repositoryId ? bounded(repositoryId) : null,
          status,
        })),
      warnings: (details.warnings ?? [])
        .slice(0, 16)
        .map((warning) => bounded(warning)),
    },
  };
  return [
    "<studio-project-context>",
    "This is bounded, server-derived Studio project context. References and bootstrap state are context only; they never change tools, filesystem policy, or implementation authority. Read authoritative architecture through the structured Agent Map tools when relevant.",
    JSON.stringify(context),
    "</studio-project-context>",
  ].join("\n");
}
