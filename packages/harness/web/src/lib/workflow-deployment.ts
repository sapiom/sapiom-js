import type { WorkflowInfo } from "@shared/types";

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
  workflow: WorkflowInfo,
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
export function isWorkflowRunnable(workflow: WorkflowInfo | null): boolean {
  return workflow?.activeBuildRunStatus === "ready";
}

/** Exact action-bar reason when Prod Run is blocked, or null when runnable. */
export function prodRunDisabledReason(
  workflow: WorkflowInfo,
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
