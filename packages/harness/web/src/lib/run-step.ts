import type { RunView, StepView } from "@shared/types";

/** RunView steps are keyed by the manifest step name == the Canvas node id. */
export function runStepFor(run: RunView | null, nodeId: string): StepView | null {
  if (!run) return null;
  // Retries append another entry with the same step name. The most recent
  // attempt is the current evidence; returning the first would pin the
  // inspector to a stale failure after a successful retry.
  for (let i = run.steps.length - 1; i >= 0; i--) {
    if (run.steps[i].name === nodeId) return run.steps[i];
  }
  return null;
}
