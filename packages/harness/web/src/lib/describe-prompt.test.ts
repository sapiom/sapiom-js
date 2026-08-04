/**
 * Unit test for `describeWorkflowPrompt`. Deliberately minimal: the prompt's
 * exact wording is exercised by the e2e (which asserts the injected payload),
 * so asserting the literal instructions here would just restate the source and
 * break on any harmless copy edit. This guards the one thing a pure builder can
 * actually get wrong — threading the GIVEN workflow's identity through rather
 * than a hardcoded one.
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
  it("threads the given workflow's name and path through — never a hardcoded one", () => {
    const leasing = describeWorkflowPrompt(workflow());
    expect(leasing).toContain('"leasing"');
    expect(leasing).toContain("/Users/demo/acme-app/leasing");
    expect(leasing).toContain("whole agent");
    expect(leasing.toLowerCase()).not.toContain("workflow");

    const rfq = describeWorkflowPrompt(workflow({ name: "rfq", path: "/Users/demo/rfq-workflows" }));
    expect(rfq).toContain('"rfq"');
    expect(rfq).toContain("/Users/demo/rfq-workflows");
    expect(rfq).not.toContain("leasing");
  });
});
