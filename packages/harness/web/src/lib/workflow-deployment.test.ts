import { describe, expect, it } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import {
  isWorkflowRunnable,
  prodRunDisabledReason,
  workflowDeploymentState,
} from "./workflow-deployment";

function workflow(overrides: Partial<WorkflowInfo> = {}): WorkflowInfo {
  return {
    path: "/agent",
    name: "agent",
    definitionId: null,
    definitionSlug: null,
    source: "connect",
    ...overrides,
  };
}

describe("workflowDeploymentState", () => {
  it("keeps an unlinked project in draft", () => {
    expect(workflowDeploymentState(workflow())).toBe("draft");
  });

  it("does not mistake a linked definition for a runnable deployment", () => {
    const linked = workflow({ definitionId: 42, definitionSlug: "agent" });
    expect(workflowDeploymentState(linked)).toBe("linked");
    expect(isWorkflowRunnable(linked)).toBe(false);
    expect(prodRunDisabledReason(linked)).toBe("No ready deployment yet");
  });

  it.each(["pending", "queued", "building"])(
    "collapses %s to building",
    (activeBuildRunStatus) => {
      const value = workflow({ definitionId: 42, activeBuildRunStatus });
      expect(workflowDeploymentState(value)).toBe("building");
      expect(prodRunDisabledReason(value)).toBe("Build in progress");
    },
  );

  it.each(["failed", "cancelled", "superseded", "stale"])(
    "collapses %s to failed",
    (activeBuildRunStatus) => {
      const value = workflow({ definitionId: 42, activeBuildRunStatus });
      expect(workflowDeploymentState(value)).toBe("failed");
      expect(prodRunDisabledReason(value)).toBe(
        "Last deploy failed — retry Deploy",
      );
    },
  );

  it("uses a local terminal error when cloud status is unavailable", () => {
    const linked = workflow({ definitionId: 42 });
    expect(workflowDeploymentState(linked, "build failed")).toBe("failed");
  });

  it("treats only ready as runnable and lets ready outrank a stale error", () => {
    const ready = workflow({
      definitionId: 42,
      activeBuildRunId: "build-1",
      activeBuildRunStatus: "ready",
    });
    expect(workflowDeploymentState(ready, "old error")).toBe("ready");
    expect(isWorkflowRunnable(ready)).toBe(true);
    expect(prodRunDisabledReason(ready, "old error")).toBeNull();
  });
});
