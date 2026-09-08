import type { WorkflowInfo } from "@shared/types";

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
  deploymentLookup?: WorkflowInfo["deploymentLookup"];
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
export function isWorkflowRunnable(
  workflow: DeployableWorkflow | null,
): boolean {
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

export const DEPLOYMENT_UNAVAILABLE = "Deployment status unavailable";
export const DEPLOYMENT_RETAINED =
  "Couldn't refresh deployment status; showing the last confirmed status.";

/** Display evidence is deliberately separate from the action gates above. */
export function workflowDeploymentIndicator(workflow: DeployableWorkflow): {
  indicator: "draft" | "deployed" | null;
  unavailable: boolean;
} {
  const lookup = workflow.deploymentLookup;
  const deployed = lookup
    ? lookup.lastConfirmedDeployed
    : workflow.definitionId == null
      ? false
      : workflow.activeBuildRunStatus
        ? workflow.activeBuildRunStatus === "ready"
        : null;
  return {
    indicator: deployed === null ? null : deployed ? "deployed" : "draft",
    unavailable: lookup?.unavailable ?? deployed === null,
  };
}

export function workflowDeploymentTitle(workflow: DeployableWorkflow): string {
  const display = workflowDeploymentIndicator(workflow);
  if (display.unavailable)
    return display.indicator === null
      ? DEPLOYMENT_UNAVAILABLE
      : DEPLOYMENT_RETAINED;
  switch (workflowDeploymentState(workflow)) {
    case "ready":
      return "Deployed to Sapiom with a ready build.";
    case "building":
      return "Cloud build in progress.";
    case "failed":
      return "Cloud build failed.";
    case "linked":
      return "Linked to Sapiom; no ready build confirmed.";
    case "draft":
      return "Draft. Not deployed to Sapiom yet.";
  }
}

export function unavailableWorkflowDeployment(
  workflow: WorkflowInfo,
  forget = false,
): WorkflowInfo {
  const indicator = workflowDeploymentIndicator(workflow).indicator;
  return {
    ...workflow,
    definitionSlug: forget ? null : workflow.definitionSlug,
    activeBuildRunId: null,
    activeBuildRunStatus: null,
    deploymentLookup: {
      lastConfirmedDeployed:
        workflow.definitionId == null
          ? false
          : forget || indicator === null
            ? null
            : indicator === "deployed",
      unavailable: workflow.definitionId != null,
    },
  };
}
