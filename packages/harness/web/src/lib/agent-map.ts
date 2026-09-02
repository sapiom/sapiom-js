import type {
  AcceptedProposalDelta,
  AgentMapWorkspaceResponse,
  AgentMapWorkspaceState,
  StudioProjectBindingSummary,
  StudioProjectSummary,
  StudioCurrentWorkspaceResponse,
  StudioWorkspaceSelection,
} from "@shared/agent-map";
import {
  parseAcceptedProposalDelta as parseSharedAcceptedProposalDelta,
  parseMapChangeProposal,
} from "@shared/agent-map-codec";
import type { WorkspaceScopeSummary } from "@shared/system-graph";

import { isWithinDir, stripTrailingSep } from "./paths";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    !hasControlCharacter(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes(":")
  );
}

function isProjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^project_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseBinding(value: unknown): StudioProjectBindingSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "status"]) ||
    !isOpaqueId(value.id) ||
    (value.status !== "active" && value.status !== "missing")
  ) {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
  };
}

function parseProject(value: unknown): StudioProjectSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "projectId",
      "identityVersion",
      "displayName",
      "bindings",
      "createdAt",
      "updatedAt",
    ]) ||
    !isProjectId(value.projectId) ||
    !Number.isSafeInteger(value.identityVersion) ||
    (value.identityVersion as number) < 1 ||
    typeof value.displayName !== "string" ||
    value.displayName === "" ||
    value.displayName !== value.displayName.trim() ||
    hasControlCharacter(value.displayName) ||
    value.displayName.includes("/") ||
    value.displayName.includes("\\") ||
    !Array.isArray(value.bindings) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    return null;
  }
  const bindings = value.bindings.map(parseBinding);
  if (bindings.some((binding) => binding === null)) return null;
  const parsed = bindings as StudioProjectBindingSummary[];
  if (new Set(parsed.map((binding) => binding.id)).size !== parsed.length) {
    return null;
  }
  return {
    projectId: value.projectId,
    identityVersion: value.identityVersion as number,
    displayName: value.displayName,
    bindings: parsed,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseWorkspace(
  value: unknown,
  expectedProjectId: string,
): AgentMapWorkspaceState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "projectId",
      "schemaVersion",
      "recordVersion",
      "confirmedRevisionId",
      "activeProposalId",
      "projectBuildPlanId",
      "createdAt",
      "updatedAt",
    ]) ||
    value.projectId !== expectedProjectId ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.recordVersion) ||
    (value.recordVersion as number) < 1 ||
    ![
      value.confirmedRevisionId,
      value.activeProposalId,
      value.projectBuildPlanId,
    ].every((candidate) => candidate === null || isOpaqueId(candidate)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    return null;
  }
  return value as unknown as AgentMapWorkspaceState;
}

function parseProposal(
  value: unknown,
  projectId: string,
  activeProposalId: string | null,
): AgentMapWorkspaceResponse["proposal"] | undefined {
  if (value === null) return activeProposalId === null ? null : undefined;
  if (activeProposalId === null) return undefined;
  try {
    return parseMapChangeProposal(value, projectId, activeProposalId);
  } catch {
    return undefined;
  }
}

/** Strictly validates the path-free Agent Map HTTP boundary. */
export function parseAgentMapWorkspaceResponse(
  value: unknown,
  expectedProjectId?: string,
): AgentMapWorkspaceResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "project",
      "workspace",
      "proposal",
    ]) ||
    value.schemaVersion !== 1
  ) {
    throw new Error("Invalid Agent Map workspace response");
  }
  const project = parseProject(value.project);
  if (
    !project ||
    (expectedProjectId && project.projectId !== expectedProjectId)
  ) {
    throw new Error("Invalid Agent Map workspace response");
  }
  const workspace = parseWorkspace(value.workspace, project.projectId);
  if (!workspace) throw new Error("Invalid Agent Map workspace response");
  const proposal = parseProposal(
    value.proposal,
    project.projectId,
    workspace.activeProposalId,
  );
  if (proposal === undefined)
    throw new Error("Invalid Agent Map workspace response");
  return { schemaVersion: 1, project, workspace, proposal };
}

/** Strict browser boundary for one attributed post-commit notification. */
export function parseAcceptedProposalDelta(
  value: unknown,
  expectedProjectId?: string,
): AcceptedProposalDelta {
  try {
    return parseSharedAcceptedProposalDelta(value, expectedProjectId);
  } catch {
    throw new Error("Invalid Agent Map proposal delta");
  }
}

export type AgentMapDeltaRoute =
  | { status: "accepted"; delta: AcceptedProposalDelta }
  | { status: "malformed-active" }
  | { status: "ignored" };

/** Route by the announced project before deciding whether parse failure is visible. */
export function routeAcceptedProposalDelta(
  value: unknown,
  activeProjectId: string,
): AgentMapDeltaRoute {
  try {
    return { status: "accepted", delta: parseAcceptedProposalDelta(value) };
  } catch {
    return isRecord(value) && value.projectId === activeProjectId
      ? { status: "malformed-active" }
      : { status: "ignored" };
  }
}

function parseSelection(
  value: unknown,
  projectId: string,
): StudioWorkspaceSelection | null {
  if (!isRecord(value) || value.projectId !== projectId) return null;
  if (
    value.kind === "agent-map" &&
    hasExactKeys(value, ["kind", "projectId"])
  ) {
    return { kind: "agent-map", projectId };
  }
  if (
    value.kind === "agent" &&
    hasExactKeys(value, ["kind", "projectId", "agentId"]) &&
    isOpaqueId(value.agentId)
  ) {
    return { kind: "agent", projectId, agentId: value.agentId };
  }
  return null;
}

/** Strict parser for the path-free durable selection boundary. */
export function parseStudioCurrentWorkspaceResponse(
  value: unknown,
  expectedProjectId: string,
): StudioCurrentWorkspaceResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["projectId", "selection", "agents", "repaired"]) ||
    value.projectId !== expectedProjectId ||
    typeof value.repaired !== "boolean" ||
    !Array.isArray(value.agents)
  )
    throw new Error("Invalid Studio current-workspace response");
  const selection = parseSelection(value.selection, expectedProjectId);
  const agents = value.agents.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["agentId", "name", "definitionId"]) ||
      !isOpaqueId(candidate.agentId) ||
      typeof candidate.name !== "string" ||
      !candidate.name ||
      (candidate.definitionId !== null &&
        !Number.isSafeInteger(candidate.definitionId))
    )
      return null;
    return {
      agentId: candidate.agentId,
      name: candidate.name,
      definitionId: candidate.definitionId as number | null,
    };
  });
  if (!selection || agents.some((agent) => agent === null)) {
    throw new Error("Invalid Studio current-workspace response");
  }
  return {
    projectId: expectedProjectId,
    selection,
    agents: agents as StudioCurrentWorkspaceResponse["agents"],
    repaired: value.repaired,
  };
}

/** Client-only restore guard; the server applies the same rule authoritatively. */
export function resolveStudioWorkspaceSelection(
  projectId: string,
  selection: StudioWorkspaceSelection | null | undefined,
  agentIds: readonly string[],
): { selection: StudioWorkspaceSelection; repair: boolean } {
  if (!selection)
    return { selection: { kind: "agent-map", projectId }, repair: false };
  if (selection.projectId !== projectId) {
    return { selection: { kind: "agent-map", projectId }, repair: true };
  }
  if (selection.kind === "agent" && !agentIds.includes(selection.agentId)) {
    return { selection: { kind: "agent-map", projectId }, repair: true };
  }
  return { selection, repair: false };
}

/**
 * The durable Studio project owning a path. Nested opened projects use the
 * nearest containing root, matching session scope rather than recent-dir order.
 */
export function mostSpecificStudioScope(
  targetPath: string,
  scopes: readonly WorkspaceScopeSummary[],
  projects: readonly StudioProjectSummary[],
): (WorkspaceScopeSummary & { projectId: string }) | null {
  const projectIds = new Set(projects.map((project) => project.projectId));
  return (
    scopes
      .filter((scope): scope is WorkspaceScopeSummary & { projectId: string } =>
        Boolean(
          scope.projectId &&
          projectIds.has(scope.projectId) &&
          isWithinDir(scope.cwd, targetPath),
        ),
      )
      .map((scope) => ({
        scope,
        depth: stripTrailingSep(scope.cwd).length,
      }))
      .sort(
        (left, right) =>
          right.depth - left.depth ||
          left.scope.projectId.localeCompare(right.scope.projectId),
      )[0]?.scope ?? null
  );
}
