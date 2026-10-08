import type { ProjectAgentSession, StudioProjectId } from "@sapiom/agent-map";
import type { HarnessSession } from "../shared/types.js";
import { isWithinDir } from "@sapiom/agent-map/paths";
import { canonicalGraphPath } from "@sapiom/agent-map/node/canonical-graph-path";
import type { StudioProjectIdentity } from "@sapiom/agent-map/node/studio-project-catalog";

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
      identity.sessionId === expected.sessionId,
  );
}

export async function isProjectSessionDispatchAuthorized(input: {
  session: HarnessSession;
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
  let project: StudioProjectIdentity | null;
  try {
    project = await input.resolveProject(expected.projectId);
  } catch {
    return false;
  }
  return Boolean(
    project &&
      input.session.id === expected.sessionId &&
      samePrincipal(input.session.agentMapIdentity, expected) &&
      isWithinCurrentProject(project, input.session.cwd),
  );
}
