import { describe, expect, it } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import {
  deploymentStateLabel,
  deploymentStateTitle,
  isWorkflowRunnable,
  prodRunBlockedToast,
  snippetsPendingSentence,
  prodRunDisabledReason,
  workflowDeploymentState,
  workflowDeploymentIndicator,
  unavailableWorkflowDeployment,
  workflowDeploymentTitle,
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

  it("reports a definition the signed-in account cannot see as unavailable, not linked", () => {
    const hidden = workflow({
      definitionId: 42,
      definitionAccess: "unavailable",
    });
    expect(workflowDeploymentState(hidden)).toBe("unavailable");
    expect(isWorkflowRunnable(hidden)).toBe(false);
    expect(prodRunDisabledReason(hidden)).toBe(
      "Agent not available on this account",
    );
  });

  it("lets unavailable outrank a build status the registry remembered for that definition", () => {
    const stale = workflow({
      definitionId: 42,
      activeBuildRunId: "build-1",
      activeBuildRunStatus: "ready",
      definitionAccess: "unavailable",
    });
    expect(workflowDeploymentState(stale, "old error")).toBe("unavailable");
    expect(isWorkflowRunnable(stale)).toBe(false);
  });

  it("keeps a visible definition on the build-status path", () => {
    const visible = workflow({
      definitionId: 42,
      activeBuildRunStatus: "ready",
      definitionAccess: "visible",
    });
    expect(workflowDeploymentState(visible)).toBe("ready");
    expect(isWorkflowRunnable(visible)).toBe(true);
    expect(
      workflowDeploymentState(
        workflow({ definitionId: 42, definitionAccess: "visible" }),
      ),
    ).toBe("linked");
  });

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

describe("deploymentStateTitle", () => {
  it("gives every state its own tooltip and names the account for unavailable", () => {
    const states = [
      "draft",
      "linked",
      "unavailable",
      "building",
      "ready",
      "failed",
    ] as const;
    const titles = states.map((state) => deploymentStateTitle(state));
    expect(new Set(titles).size).toBe(states.length);
    expect(deploymentStateTitle("unavailable")).toContain("this account");
  });
});

describe("deployment-state copy helpers", () => {
  it("give unavailable its own account-scoped copy on every surface", () => {
    expect(deploymentStateLabel("unavailable")).toBe("unavailable");
    expect(prodRunBlockedToast("unavailable")).toBe(
      "This agent isn't available on the signed-in account.",
    );
    expect(snippetsPendingSentence("unavailable", "billing")).toContain(
      "this account can't see",
    );
  });

  it("treat ready as deployed with nothing pending", () => {
    expect(deploymentStateLabel("ready")).toBe("deployed");
    expect(snippetsPendingSentence("ready", "billing")).toBeNull();
    expect(prodRunBlockedToast("linked")).toBe(
      "No ready deployment yet — deploy it first.",
    );
  });
});

it.each([null, "ready", "building", "failed"])(
  "uses conservative legacy display evidence for %s",
  (activeBuildRunStatus) => {
    const value = workflow({ definitionId: 42, activeBuildRunStatus });
    expect(workflowDeploymentIndicator(value)).toEqual({
      indicator:
        activeBuildRunStatus === null
          ? null
          : activeBuildRunStatus === "ready"
            ? "deployed"
            : "draft",
      unavailable: activeBuildRunStatus === null,
    });
  },
);
it("retains display evidence through list failures but forgets it on auth change", () => {
  const ready = workflow({
    definitionId: 42,
    activeBuildRunId: "build-1",
    activeBuildRunStatus: "ready",
  });
  const retained = unavailableWorkflowDeployment(ready);
  expect(workflowDeploymentIndicator(retained)).toEqual({
    indicator: "deployed",
    unavailable: true,
  });
  expect(workflowDeploymentTitle(retained)).toBe(
    workflowDeploymentTitle(ready),
  );
  expect(retained.activeBuildRunId).toBeNull();
  expect(isWorkflowRunnable(retained)).toBe(false);
  expect(prodRunDisabledReason(retained)).not.toBeNull();
  expect(
    unavailableWorkflowDeployment(
      { ...retained, definitionSlug: "private" },
      true,
    ).definitionSlug,
  ).toBeNull();
  expect(
    workflowDeploymentIndicator(unavailableWorkflowDeployment(retained, true)),
  ).toEqual({ indicator: null, unavailable: true });
  expect(
    workflowDeploymentIndicator(
      unavailableWorkflowDeployment(workflow(), true),
    ),
  ).toEqual({ indicator: "draft", unavailable: false });
});
