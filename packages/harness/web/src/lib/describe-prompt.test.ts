/**
 * Unit tests for `describeWorkflowPrompt` — the prompt the canvas "Describe with
 * AI" action injects. Pure, DOM-free. Covers: the workflow name and source path
 * are threaded in, the agent is told to write `description` on both defineAgent
 * and defineStep, the "don't touch logic" and SDK-version guards are present,
 * and the "canvas re-renders on save" contract is stated (no manual step).
 */
import { describe, expect, it } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import { describeWorkflowPrompt } from "./describe-prompt";

const workflow = (over: Partial<WorkflowInfo> = {}): WorkflowInfo =>
  ({
    name: "leasing",
    path: "/Users/demo/acme-app/leasing",
    definitionId: 4821,
    definitionSlug: "leasing",
    source: "scan",
    ...over,
  }) as WorkflowInfo;

describe("describeWorkflowPrompt", () => {
  it("threads the workflow name and source path into the prompt", () => {
    const p = describeWorkflowPrompt(workflow());
    expect(p).toContain('"leasing"');
    expect(p).toContain("/Users/demo/acme-app/leasing");
  });

  it("asks for descriptions on both the workflow and every step", () => {
    const p = describeWorkflowPrompt(workflow());
    expect(p).toContain("defineAgent");
    expect(p).toContain("defineStep");
    expect(p.toLowerCase()).toContain("description");
  });

  it("guards logic and the SDK version, and promises an automatic re-render", () => {
    const p = describeWorkflowPrompt(workflow());
    // Don't rewrite the workflow — only the description fields.
    expect(p).toMatch(/only add or refine .*description/i);
    expect(p).toMatch(/do not change any logic/i);
    // The field needs a recent SDK.
    expect(p).toContain("@sapiom/agent");
    // No manual render step — the source watcher re-renders on save.
    expect(p.toLowerCase()).toContain("re-renders automatically");
  });

  it("reflects a different workflow's identity", () => {
    const p = describeWorkflowPrompt(workflow({ name: "rfq", path: "/Users/demo/rfq-workflows" }));
    expect(p).toContain('"rfq"');
    expect(p).toContain("/Users/demo/rfq-workflows");
    expect(p).not.toContain("leasing");
  });
});
