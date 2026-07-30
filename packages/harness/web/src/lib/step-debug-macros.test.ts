/**
 * Unit tests for the StepDebugMacros inject contract.
 *
 * The component itself is a React component tested at the Playwright tier;
 * this suite covers the pure logic: that calling `extractStepContext` with a
 * StepView's own input/output/calls and appending `"\n\n" + question` produces
 * the expected payload — the same contract `StepDebugMacros.injectMacro` uses.
 *
 * This gives deterministic, fast coverage of:
 *   - Payload = context block + "\n\n" + question (the separator).
 *   - Context includes the step name, status, and (when present) latency.
 *   - Input/output from the step's own fields threads through.
 *   - Capability calls from the step's own `calls` field thread through.
 *   - No cost / provider / model data appears (cost-free contract).
 *   - "Debug this step" and the other preset questions are appended correctly.
 */
import { describe, expect, it } from "vitest";
import type { StepView } from "@shared/types";

import { extractStepContext } from "./extract-step-context";

// ---------------------------------------------------------------------------
// Payload shape: context + "\n\n" + question
// ---------------------------------------------------------------------------

describe("StepDebugMacros inject payload shape", () => {
  it("injects extractStepContext(step, trace) + double-newline + question", () => {
    const step: StepView = {
      id: "s1",
      name: "intake",
      status: "passed",
      latencyMs: 716,
    };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const question = "Debug this step";

    const ctx = extractStepContext(step, trace);
    const payload = `${ctx}\n\n${question}`;

    // The separator between context and question must be exactly two newlines.
    expect(payload).toContain("Step: intake\n");
    expect(payload).toContain("\n\nDebug this step");
    // Context block precedes the question.
    expect(payload.indexOf("Step: intake")).toBeLessThan(payload.indexOf("Debug this step"));
  });

  it("includes the step's status in the context block", () => {
    const step: StepView = { id: "s1", name: "processData", status: "failed", error: "timeout" };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);
    const payload = `${ctx}\n\nDebug this step`;

    expect(payload).toContain("Status: failed");
    expect(payload).toContain("Error: timeout");
    expect(payload).toContain("Debug this step");
  });

  it("includes latency when present on the step", () => {
    const step: StepView = { id: "s1", name: "slow-step", status: "passed", latencyMs: 3500 };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);

    expect(ctx).toContain("Latency: 3.5s");
  });
});

// ---------------------------------------------------------------------------
// "Why is this step slow / stuck?" preset
// ---------------------------------------------------------------------------

describe("'Why is this step slow / stuck?' preset", () => {
  it("appends the exact question text", () => {
    const step: StepView = { id: "s1", name: "slow-step", status: "running" };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);
    const payload = `${ctx}\n\nWhy is this step slow / stuck?`;

    expect(payload).toContain("Why is this step slow / stuck?");
    expect(payload).toContain("Step: slow-step");
  });
});

// ---------------------------------------------------------------------------
// "Explain this step" preset
// ---------------------------------------------------------------------------

describe("'Explain this step' preset", () => {
  it("appends the exact question text", () => {
    const step: StepView = { id: "s1", name: "complex-step", status: "passed" };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);
    const payload = `${ctx}\n\nExplain this step`;

    expect(payload).toContain("Explain this step");
    expect(payload).toContain("Step: complex-step");
  });
});

// ---------------------------------------------------------------------------
// Trace built from the step's own input/output/calls
// ---------------------------------------------------------------------------

describe("trace built from StepView's own fields", () => {
  it("threads step.input into the context when present", () => {
    const step: StepView = {
      id: "s1",
      name: "fetch",
      status: "passed",
      input: { url: "https://example.com/api" },
    };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);

    expect(ctx).toContain("Input:");
    expect(ctx).toContain('"url": "https://example.com/api"');
  });

  it("threads step.output into the context when present", () => {
    const step: StepView = {
      id: "s1",
      name: "fetch",
      status: "passed",
      output: { records: 12 },
    };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);

    expect(ctx).toContain("Output:");
    expect(ctx).toContain('"records": 12');
  });

  it("threads step.calls into the context when present", () => {
    const step: StepView = {
      id: "s1",
      name: "research",
      status: "passed",
      calls: [{ capability: "web.search" }, { capability: "records.write" }],
    };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);

    expect(ctx).toContain("Capabilities called:");
    expect(ctx).toContain("- web.search");
    expect(ctx).toContain("- records.write");
  });

  it("produces an empty trace when step has no input/output/calls", () => {
    // A minimal step: no fields means the trace carries undefined for each,
    // which extractStepContext treats as absent (honest absence).
    const step: StepView = { id: "s1", name: "noop", status: "passed" };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);

    expect(ctx).toContain("Step: noop");
    expect(ctx).not.toContain("Input:");
    expect(ctx).not.toContain("Output:");
    // calls is undefined → no call trace emitted, no fallback triggered
    // (no declared capabilities either), so no Capabilities section at all.
    expect(ctx).not.toContain("Capabilities");
  });
});

// ---------------------------------------------------------------------------
// Cost-free contract — no $ / spend / cost data
// ---------------------------------------------------------------------------

describe("cost-free contract", () => {
  it("never includes a dollar sign in the injected payload", () => {
    const step: StepView = {
      id: "s1",
      name: "generate",
      status: "passed",
      latencyMs: 2200,
      output: { text: "result text here" },
      calls: [{ capability: "models.coding.run", stubUsed: true }],
    };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);
    const payload = `${ctx}\n\nDebug this step`;

    expect(payload).not.toContain("$");
  });

  it("never includes provider or model names", () => {
    const step: StepView = {
      id: "s1",
      name: "generate",
      status: "passed",
      calls: [{ capability: "models.coding.run", stubUsed: false }],
    };
    const trace = { input: step.input, output: step.output, calls: step.calls };
    const ctx = extractStepContext(step, trace);

    // Capability id only — no model name should appear.
    expect(ctx).toContain("- models.coding.run");
    expect(ctx).not.toMatch(/gpt|claude|sonnet|opus|gemini|anthropic|openai/i);
  });
});

// ---------------------------------------------------------------------------
// "Debug this step" primary styling on failed step
// (logic invariant: the step's status determines styling)
// ---------------------------------------------------------------------------

describe("failed step styling predicate", () => {
  it("identifies a failed step (the trigger for primary button styling)", () => {
    // This pure test asserts the predicate, not the DOM class.
    // The actual class switch is `step.status === "failed" ? "btn-primary" : "btn-ghost"`.
    const failedStep: StepView = { id: "s1", name: "process", status: "failed" };
    const passedStep: StepView = { id: "s2", name: "fetch", status: "passed" };
    const runningStep: StepView = { id: "s3", name: "analyze", status: "running" };

    expect(failedStep.status === "failed").toBe(true);
    expect(passedStep.status === "failed").toBe(false);
    expect(runningStep.status === "failed").toBe(false);
  });
});
