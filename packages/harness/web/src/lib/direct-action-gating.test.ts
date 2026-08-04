/**
 * Unit tests for the direct-action gating rules introduced in the
 * "never let a direct action fail silently" fix:
 *
 *  Fix 1 — blocked direct actions must produce a toast reason, not silence.
 *  Fix 3 — deploy failure state is distinct from "never deployed".
 *  Fix 5 — unauthenticated disables all auth-requiring actions.
 *
 * These tests exercise the pure gating logic (no DOM, no React), matching
 * the existing pattern in macro-actions.test.ts and macro-gating tests.
 */
import { describe, expect, it } from "vitest";

import type { MacroDef, WorkflowInfo } from "@shared/types";
import { macroDisabledReason } from "./macro-gating";
import {
  isWorkflowRunnable,
  prodRunDisabledReason,
  workflowDeploymentState,
} from "./workflow-deployment";

// ---------------------------------------------------------------------------
// Helpers — mirror the pure gating rules from SessionStepsBar without
// importing the component itself (no jsdom needed for these assertions).
// ---------------------------------------------------------------------------

type GatingInput = {
  /** Simulated per-action needsDeploy flag. */
  needsDeploy: boolean;
  /** Simulated per-action needsAuth flag. */
  needsAuth: boolean;
  workflow: WorkflowInfo;
  /** Whether a previous deploy failed. */
  lastDeployError: string | null;
  /** Whether the user is authenticated. */
  authenticated: boolean;
};

/**
 * Mirrors the disabled-reason priority chain in SessionStepsBar:
 *   authReason > funnelReason > readyReason > macroDisabledReason
 *
 * We only test the two new layers (auth + deploy-error distinction) here;
 * the existing readyReason / macroDisabledReason coverage lives in the
 * existing macro-gating suite.
 */
function computeDisabledReason(input: GatingInput): string | null {
  // Fix 5: auth gate — always check first.
  if (input.needsAuth && !input.authenticated) {
    return "Connect your account first";
  }
  // Fix 3: deploy gate — distinguish failed-deploy from virgin.
  if (input.needsDeploy) {
    return prodRunDisabledReason(input.workflow, input.lastDeployError);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fix 5: Auth precondition
// ---------------------------------------------------------------------------

describe("Fix 5 — auth precondition disables auth-requiring actions", () => {
  const draft = makeWorkflow();
  const ready = makeWorkflow({
    definitionId: 42,
    activeBuildRunId: "build-1",
    activeBuildRunStatus: "ready",
  });

  it("Deploy is disabled with 'Connect your account first' when not authenticated", () => {
    const reason = computeDisabledReason({
      needsDeploy: false,
      needsAuth: true,
      workflow: draft,
      lastDeployError: null,
      authenticated: false,
    });
    expect(reason).toBe("Connect your account first");
  });

  it("Prod Run is disabled with auth reason when not authenticated", () => {
    const reason = computeDisabledReason({
      needsDeploy: true,
      needsAuth: true,
      workflow: ready,
      lastDeployError: null,
      authenticated: false,
    });
    expect(reason).toBe("Connect your account first");
  });

  it("auth reason takes priority over deploy-gate reason", () => {
    // Not authenticated AND not deployed — auth wins.
    const reason = computeDisabledReason({
      needsDeploy: true,
      needsAuth: true,
      workflow: draft,
      lastDeployError: null,
      authenticated: false,
    });
    expect(reason).toBe("Connect your account first");
  });

  it("Local Run does not require auth (needsAuth=false) — auth=false does not block it", () => {
    const reason = computeDisabledReason({
      needsDeploy: false,
      needsAuth: false,
      workflow: draft,
      lastDeployError: null,
      authenticated: false,
    });
    expect(reason).toBeNull();
  });

  it("all three actions are enabled when authenticated", () => {
    // Deploy (needsAuth, !needsDeploy)
    expect(
      computeDisabledReason({
        needsDeploy: false,
        needsAuth: true,
        workflow: draft,
        lastDeployError: null,
        authenticated: true,
      }),
    ).toBeNull();

    // Prod Run (needsAuth, needsDeploy, deployed)
    expect(
      computeDisabledReason({
        needsDeploy: true,
        needsAuth: true,
        workflow: ready,
        lastDeployError: null,
        authenticated: true,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Deploy-failed vs. never-deployed distinction
// ---------------------------------------------------------------------------

describe("Fix 3 — Prod Run disabled-reason distinguishes deploy-failed from never-deployed", () => {
  const base: GatingInput = {
    needsDeploy: true,
    needsAuth: true,
    workflow: makeWorkflow(),
    lastDeployError: null,
    authenticated: true,
  };

  it("reads 'Not deployed yet' when no deploy has ever been attempted", () => {
    const reason = computeDisabledReason({ ...base, lastDeployError: null });
    expect(reason).toBe("Not deployed yet");
  });

  it("reads 'Last deploy failed — retry Deploy' after a deploy failure", () => {
    const reason = computeDisabledReason({
      ...base,
      lastDeployError: "Deploy failed: mock build error (check your agent definition)",
    });
    expect(reason).toBe("Last deploy failed — retry Deploy");
  });

  it("is not disabled when a ready build exists — regardless of a stale local error", () => {
    const reason = computeDisabledReason({
      ...base,
      workflow: makeWorkflow({
        definitionId: 42,
        activeBuildRunId: "build-1",
        activeBuildRunStatus: "ready",
      }),
      lastDeployError: "stale error (should have been cleared)",
    });
    expect(reason).toBeNull();
  });

  it("reason is null for Local Run (needsDeploy=false) — no deploy gate", () => {
    const reason = computeDisabledReason({
      needsDeploy: false,
      needsAuth: false,
      workflow: makeWorkflow(),
      lastDeployError: "some error",
      authenticated: true,
    });
    expect(reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Blocked direct-action toast reasons (pure message mapping)
// ---------------------------------------------------------------------------

describe("Fix 1 — blocked direct actions produce a specific toast reason", () => {
  /**
   * Models the App.tsx handleRunMacroForWorkflow direct-action branches.
   * Returns the toast message that MUST be shown (never a silent return).
   */
  function directActionToastReason(
    kind: "deploy" | "prod-run" | "run-local",
    workflow: WorkflowInfo | null,
    lastDeployError: string | null,
  ): string | null {
    if (kind === "deploy") {
      return workflow ? null : "Select an agent first.";
    }
    if (kind === "prod-run") {
      if (isWorkflowRunnable(workflow)) return null;
      const state = workflow
        ? workflowDeploymentState(workflow, lastDeployError)
        : "draft";
      return state === "failed"
        ? "Last deploy failed — retry Deploy."
        : state === "building"
          ? "The cloud build is still in progress."
          : state === "linked"
            ? "No ready deployment yet — deploy it first."
            : "This agent isn't deployed yet — deploy it first.";
    }
    if (kind === "run-local") {
      return workflow ? null : "Select an agent first.";
    }
    return null;
  }

  it("deploy with no agent toasts 'Select an agent first.'", () => {
    expect(directActionToastReason("deploy", null, null)).toBe("Select an agent first.");
  });

  it("deploy with a workflow proceeds (no toast)", () => {
    const wf = { path: "/p", name: "p", definitionId: null, definitionSlug: null, source: "connect" } as WorkflowInfo;
    expect(directActionToastReason("deploy", wf, null)).toBeNull();
  });

  it("run-local with no agent toasts 'Select an agent first.'", () => {
    expect(directActionToastReason("run-local", null, null)).toBe("Select an agent first.");
  });

  it("run-local with a workflow proceeds (no toast)", () => {
    const wf = { path: "/p", name: "p", definitionId: null, definitionSlug: null, source: "connect" } as WorkflowInfo;
    expect(directActionToastReason("run-local", wf, null)).toBeNull();
  });

  it("prod-run with no definitionId and no prior error toasts 'not deployed'", () => {
    const wf = { path: "/p", name: "p", definitionId: null, definitionSlug: null, source: "connect" } as WorkflowInfo;
    expect(directActionToastReason("prod-run", wf, null)).toBe(
      "This agent isn't deployed yet — deploy it first.",
    );
  });

  it("prod-run with no definitionId but a prior deploy error toasts 'retry Deploy'", () => {
    const wf = { path: "/p", name: "p", definitionId: null, definitionSlug: null, source: "connect" } as WorkflowInfo;
    expect(directActionToastReason("prod-run", wf, "Deploy failed: build error")).toBe(
      "Last deploy failed — retry Deploy.",
    );
  });

  it("prod-run with a ready build proceeds (no toast)", () => {
    const wf = makeWorkflow({
      definitionId: 42,
      activeBuildRunId: "build-1",
      activeBuildRunStatus: "ready",
    });
    expect(directActionToastReason("prod-run", wf, null)).toBeNull();
  });

  it("prod-run with only a definitionId is blocked as linked, not deployed", () => {
    const wf = makeWorkflow({ definitionId: 42 });
    expect(directActionToastReason("prod-run", wf, null)).toBe(
      "No ready deployment yet — deploy it first.",
    );
  });

  it("prod-run with no workflow at all toasts 'not deployed' (null workflow has no definitionId)", () => {
    expect(directActionToastReason("prod-run", null, null)).toBe(
      "This agent isn't deployed yet — deploy it first.",
    );
  });
});

// ---------------------------------------------------------------------------
// macroDisabledReason — regression guard for existing gating (unchanged)
// ---------------------------------------------------------------------------

function makeWorkflow(overrides: Partial<WorkflowInfo> = {}): WorkflowInfo {
  return {
    path: "/Users/demo/test",
    name: "test",
    definitionId: null,
    definitionSlug: null,
    source: "connect",
    ...overrides,
  };
}

describe("macroDisabledReason — existing gating not regressed", () => {
  /** Minimal MacroDef factory. */
  function makeMacro(overrides: Partial<MacroDef>): MacroDef {
    return {
      id: "test",
      label: "Test",
      icon: "icon",
      requiresWorkflow: false,
      action: { kind: "inject", text: "test" },
      ...overrides,
    } as MacroDef;
  }

  it("returns null when all conditions met", () => {
    const macro = makeMacro({ requiresWorkflow: true, action: { kind: "inject", text: "x" } });
    const wf = makeWorkflow();
    expect(macroDisabledReason(macro, wf, "sess-1")).toBeNull();
  });

  it("requiresWorkflow: returns 'Select an agent first' when no agent is selected", () => {
    const macro = makeMacro({ requiresWorkflow: true });
    expect(macroDisabledReason(macro, null, "sess-1")).toBe("Select an agent first");
  });

  it("non-open-url + no session: returns 'Start a session first'", () => {
    const macro = makeMacro({ requiresWorkflow: false, action: { kind: "inject", text: "x" } });
    expect(macroDisabledReason(macro, null, null)).toBe("Start a session first");
  });

  it("open-url: does not require session", () => {
    const macro = makeMacro({
      requiresWorkflow: false,
      action: { kind: "open-url", url: "https://example.com" },
    });
    expect(macroDisabledReason(macro, null, null)).toBeNull();
  });
});
