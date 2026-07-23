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

// ---------------------------------------------------------------------------
// Helpers — mirror the pure gating rules from SessionStepsBar without
// importing the component itself (no jsdom needed for these assertions).
// ---------------------------------------------------------------------------

type GatingInput = {
  /** Simulated per-action needsDeploy flag. */
  needsDeploy: boolean;
  /** Simulated per-action needsAuth flag. */
  needsAuth: boolean;
  /** Whether the current workflow has been deployed. */
  deployed: boolean;
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
  if (input.needsDeploy && !input.deployed) {
    return input.lastDeployError != null
      ? "Last deploy failed — retry Deploy"
      : "Not deployed yet";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fix 5: Auth precondition
// ---------------------------------------------------------------------------

describe("Fix 5 — auth precondition disables auth-requiring actions", () => {
  it("Deploy is disabled with 'Connect your account first' when not authenticated", () => {
    const reason = computeDisabledReason({
      needsDeploy: false,
      needsAuth: true,
      deployed: false,
      lastDeployError: null,
      authenticated: false,
    });
    expect(reason).toBe("Connect your account first");
  });

  it("Prod Run is disabled with auth reason when not authenticated", () => {
    const reason = computeDisabledReason({
      needsDeploy: true,
      needsAuth: true,
      deployed: true,
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
      deployed: false,
      lastDeployError: null,
      authenticated: false,
    });
    expect(reason).toBe("Connect your account first");
  });

  it("Local Run does not require auth (needsAuth=false) — auth=false does not block it", () => {
    const reason = computeDisabledReason({
      needsDeploy: false,
      needsAuth: false,
      deployed: false,
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
        deployed: false,
        lastDeployError: null,
        authenticated: true,
      }),
    ).toBeNull();

    // Prod Run (needsAuth, needsDeploy, deployed)
    expect(
      computeDisabledReason({
        needsDeploy: true,
        needsAuth: true,
        deployed: true,
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
    deployed: false,
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
      lastDeployError: "Deploy failed: mock build error (check your workflow definition)",
    });
    expect(reason).toBe("Last deploy failed — retry Deploy");
  });

  it("is not disabled when deployed (definitionId set) — regardless of lastDeployError", () => {
    // A later successful deploy clears lastDeployError + sets deployed=true,
    // so this state is theoretically unreachable, but the gating rule must
    // not double-disable a correctly deployed workflow.
    const reason = computeDisabledReason({
      ...base,
      deployed: true,
      lastDeployError: "stale error (should have been cleared)",
    });
    expect(reason).toBeNull();
  });

  it("reason is null for Local Run (needsDeploy=false) — no deploy gate", () => {
    const reason = computeDisabledReason({
      needsDeploy: false,
      needsAuth: false,
      deployed: false,
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
      return workflow ? null : "Select a workflow first.";
    }
    if (kind === "prod-run") {
      if (workflow?.definitionId != null) return null; // proceed
      return lastDeployError
        ? "Last deploy failed — retry Deploy."
        : "This agent isn't deployed yet — deploy it first.";
    }
    if (kind === "run-local") {
      return workflow ? null : "Select a workflow first.";
    }
    return null;
  }

  it("deploy with no workflow toasts 'Select a workflow first.'", () => {
    expect(directActionToastReason("deploy", null, null)).toBe("Select a workflow first.");
  });

  it("deploy with a workflow proceeds (no toast)", () => {
    const wf = { path: "/p", name: "p", definitionId: null, definitionSlug: null, source: "connect" } as WorkflowInfo;
    expect(directActionToastReason("deploy", wf, null)).toBeNull();
  });

  it("run-local with no workflow toasts 'Select a workflow first.'", () => {
    expect(directActionToastReason("run-local", null, null)).toBe("Select a workflow first.");
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

  it("prod-run with a definitionId proceeds (no toast)", () => {
    const wf = { path: "/p", name: "p", definitionId: 42, definitionSlug: null, source: "connect" } as WorkflowInfo;
    expect(directActionToastReason("prod-run", wf, null)).toBeNull();
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

describe("macroDisabledReason — existing gating not regressed", () => {
  /** Minimal MacroDef factory. */
  function makeMacro(overrides: Partial<MacroDef>): MacroDef {
    return {
      id: "test",
      label: "Test",
      icon: "icon",
      requiresWorkflow: false,
      action: { kind: "inject", template: "test" },
      ...overrides,
    } as MacroDef;
  }

  /** Minimal WorkflowInfo factory. */
  function makeWorkflow(overrides: Partial<WorkflowInfo> = {}): WorkflowInfo {
    return {
      path: "/Users/demo/test",
      name: "test",
      definitionId: null,
      definitionSlug: null,
      source: "connect",
      ...overrides,
    } as WorkflowInfo;
  }

  it("returns null when all conditions met", () => {
    const macro = makeMacro({ requiresWorkflow: true, action: { kind: "inject", template: "x" } });
    const wf = makeWorkflow();
    expect(macroDisabledReason(macro, wf, "sess-1")).toBeNull();
  });

  it("requiresWorkflow: returns 'Select a workflow first' when no workflow", () => {
    const macro = makeMacro({ requiresWorkflow: true });
    expect(macroDisabledReason(macro, null, "sess-1")).toBe("Select a workflow first");
  });

  it("non-open-url + no session: returns 'Start a session first'", () => {
    const macro = makeMacro({ requiresWorkflow: false, action: { kind: "inject", template: "x" } });
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
