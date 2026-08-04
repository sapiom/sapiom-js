import { describe, expect, it } from "vitest";
import type { ObservedRun } from "./use-harness-state";

import { observedRunMatchesWorkflow } from "./run-workflow-filter";

function observed(workflowPath: string | null): ObservedRun {
  return { workflowPath } as ObservedRun;
}

describe("observedRunMatchesWorkflow", () => {
  it("keeps evidence for the workflow captured when the run started", () => {
    expect(observedRunMatchesWorkflow(observed("/agent-a"), "/agent-a")).toBe(
      true,
    );
  });

  it("rejects evidence after the session is rebound to another workflow", () => {
    expect(observedRunMatchesWorkflow(observed("/agent-a"), "/agent-b")).toBe(
      false,
    );
  });

  it("only shows an unbound run while the session remains unbound", () => {
    expect(observedRunMatchesWorkflow(observed(null), null)).toBe(true);
    expect(observedRunMatchesWorkflow(observed(null), "/agent-b")).toBe(false);
  });
});
