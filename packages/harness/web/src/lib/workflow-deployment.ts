/**
 * The linkage + build fields every deployment decision reads. Structural on
 * purpose: `WorkflowInfo` satisfies it, and widening the parameters lets the
 * pure gating decisions in `session-scope.ts` reuse this ONE answer instead of
 * re-deriving deployment state from raw fields (SAP-2931). There is exactly one
 * place that turns linkage + build status into a user-facing reason, and it is
 * this module.
 */
export interface DeployableWorkflow {
  definitionId: number | null;
  activeBuildRunStatus?: string | null;
}

/** The five states Studio can prove from local linkage plus cloud build data. */
export type WorkflowDeploymentState =
  | "draft"
  | "linked"
  | "building"
  | "ready"
  | "failed";

const BUILDING_STATUSES = new Set(["pending", "queued", "building"]);
const FAILED_STATUSES = new Set(["failed", "cancelled", "superseded", "stale"]);

/**
 * Derive the user-facing cloud state without treating `definitionId` as proof
 * of a runnable build. A ready cloud projection wins over a stale local deploy
 * error (a failed rebuild can leave the previous ready version runnable).
 */
export function workflowDeploymentState(
  workflow: DeployableWorkflow,
  lastDeployError: string | null = null,
): WorkflowDeploymentState {
  if (workflow.activeBuildRunStatus === "ready") return "ready";
  if (
    workflow.activeBuildRunStatus != null &&
    BUILDING_STATUSES.has(workflow.activeBuildRunStatus)
  ) {
    return "building";
  }
  if (
    lastDeployError != null ||
    (workflow.activeBuildRunStatus != null &&
      FAILED_STATUSES.has(workflow.activeBuildRunStatus))
  ) {
    return "failed";
  }
  return workflow.definitionId == null ? "draft" : "linked";
}

/** Only the backend's ready build projection proves a production run can start. */
export function isWorkflowRunnable(workflow: DeployableWorkflow | null): boolean {
  return workflow?.activeBuildRunStatus === "ready";
}

/** Exact action-bar reason when Prod Run is blocked, or null when runnable. */
export function prodRunDisabledReason(
  workflow: DeployableWorkflow,
  lastDeployError: string | null = null,
): string | null {
  switch (workflowDeploymentState(workflow, lastDeployError)) {
    case "ready":
      return null;
    case "building":
      return "Build in progress";
    case "failed":
      return "Last deploy failed — retry Deploy";
    case "linked":
      return "No ready deployment yet";
    case "draft":
      return "Not deployed yet";
  }
}
