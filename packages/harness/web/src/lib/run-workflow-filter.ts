import type { ObservedRun } from "./use-harness-state";

/**
 * Run evidence belongs to the workflow that was bound when the run started.
 * A later rebind must not carry status, cost, or output into another agent.
 */
export function observedRunMatchesWorkflow(
  observed: ObservedRun | null,
  workflowPath: string | null,
): observed is ObservedRun {
  return observed != null && observed.workflowPath === workflowPath;
}
