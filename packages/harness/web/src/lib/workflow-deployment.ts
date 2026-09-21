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
  /** Visibility per the server's tenant-scoped list. Absent = unknown, which
   *  keeps every other state as before. */
  definitionAccess?: "visible" | "unavailable";
}

/** The six states Studio can prove from local linkage plus cloud build data. */
export type WorkflowDeploymentState =
  | "draft"
  | "linked"
  | "unavailable"
  | "building"
  | "ready"
  | "failed";

const BUILDING_STATUSES = new Set(["pending", "queued", "building"]);
const FAILED_STATUSES = new Set(["failed", "cancelled", "superseded", "stale"]);

/** Linked to a definition this account can't see. Checked before any build
 *  status: the registry may still hold a stale one. */
function isUnavailable(workflow: DeployableWorkflow): boolean {
  return (
    workflow.definitionId != null && workflow.definitionAccess === "unavailable"
  );
}

/**
 * Derive the user-facing cloud state without treating `definitionId` as proof
 * of a runnable build. A ready cloud projection wins over a stale local deploy
 * error (a failed rebuild can leave the previous ready version runnable).
 */
export function workflowDeploymentState(
  workflow: DeployableWorkflow,
  lastDeployError: string | null = null,
): WorkflowDeploymentState {
  if (isUnavailable(workflow)) return "unavailable";
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

/** Only a ready build on a definition this account can see is runnable. */
export function isWorkflowRunnable(
  workflow: DeployableWorkflow | null,
): boolean {
  return (
    workflow != null &&
    !isUnavailable(workflow) &&
    workflow.activeBuildRunStatus === "ready"
  );
}

/** Tooltip of the cloud glyph every agent row carries (rail, unrooted list). */
export function deploymentStateTitle(state: WorkflowDeploymentState): string {
  switch (state) {
    case "ready":
      return "Deployed to Sapiom with a ready build.";
    case "building":
      return "Cloud build in progress.";
    case "failed":
      return "Cloud build failed.";
    case "unavailable":
      return "Linked to an agent this account can't see: another account, or deleted.";
    case "linked":
      return "Linked to Sapiom; no ready build confirmed.";
    case "draft":
      return "Draft. Not deployed to Sapiom yet.";
  }
}

/** Short label of the right-pane cloud pill. */
export function deploymentStateLabel(state: WorkflowDeploymentState): string {
  switch (state) {
    case "ready":
      return "deployed";
    case "building":
      return "building";
    case "failed":
      return "deploy failed";
    case "unavailable":
      return "unavailable";
    case "linked":
    case "draft":
      return "linked";
  }
}

/** Toast shown when a production run is refused. */
export function prodRunBlockedToast(state: WorkflowDeploymentState): string {
  switch (state) {
    case "failed":
      return "Last deploy failed — retry Deploy.";
    case "building":
      return "The cloud build is still in progress.";
    case "unavailable":
      return "This agent isn't available on the signed-in account.";
    case "linked":
      return "No ready deployment yet — deploy it first.";
    case "draft":
    case "ready":
      // `ready` is runnable and never reaches the toast; kept for exhaustiveness.
      return "This agent isn't deployed yet — deploy it first.";
  }
}

/** Why the integration snippets are not available yet; null once they are. */
export function snippetsPendingSentence(
  state: WorkflowDeploymentState,
  agentName: string,
): string | null {
  switch (state) {
    case "ready":
      return null;
    case "building":
      return `${agentName} is linked and building. The snippets appear once the cloud build is ready.`;
    case "failed":
      return `The last deploy of ${agentName} did not produce a ready build. Fix it and deploy again.`;
    case "unavailable":
      return `${agentName} is linked to an agent this account can't see. Sign in to the account that owns it.`;
    case "linked":
    case "draft":
      return `${agentName} is linked to Sapiom, but Studio cannot confirm a ready cloud build. Deploy it before integrating.`;
  }
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
    case "unavailable":
      return "Agent not available on this account";
    case "linked":
      return "No ready deployment yet";
    case "draft":
      return "Not deployed yet";
  }
}

export const DEPLOYMENT_UNAVAILABLE = "Deployment status unavailable";

/** Display evidence is deliberately separate from the action gates above. */
export function workflowDeploymentIndicator(workflow: DeployableWorkflow): {
  indicator: "draft" | "deployed" | null;
  unavailable: boolean;
} {
  // Confirmed not visible to this account: a plain draft glyph, no outage flag.
  if (isUnavailable(workflow))
    return { indicator: "draft", unavailable: false };
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
  if (isUnavailable(workflow)) return deploymentStateTitle("unavailable");
  const display = workflowDeploymentIndicator(workflow);
  if (display.indicator === null) return DEPLOYMENT_UNAVAILABLE;
  let state = workflowDeploymentState(workflow);
  if (display.unavailable)
    state = display.indicator === "deployed" ? "ready" : "draft";
  return deploymentStateTitle(state);
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
