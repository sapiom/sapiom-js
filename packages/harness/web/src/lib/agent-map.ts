import type {
  AgentMapWorkspaceResponse,
  AgentMapWorkspaceState,
  StudioProjectBindingSummary,
  StudioProjectSummary,
} from "@shared/agent-map";

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

/** Strictly validates the path-free Agent Map HTTP boundary. */
export function parseAgentMapWorkspaceResponse(
  value: unknown,
  expectedProjectId?: string,
): AgentMapWorkspaceResponse {
  if (!isRecord(value) || !hasExactKeys(value, ["project", "workspace"])) {
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
  return { project, workspace };
}
