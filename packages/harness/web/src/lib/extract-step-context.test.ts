/**
 * Unit tests for `extractStepContext` and `formatLatency`.
 *
 * Pure, DOM-free — runs under vitest node, and is the covering suite for the
 * Stryker mutation run (see stryker.conf.json / vitest.config.mutation.ts).
 * Tests cover the step framing, the rich per-step evidence the run trace
 * exposes (input/output, capability calls, stub-used), the run-level stub
 * bookkeeping, honest absence of each section, the capability-not-model rule,
 * the declared-capabilities fallback, and the value/log truncation.
 */
import { describe, expect, it } from "vitest";
import type { StepView } from "@shared/types";

import {
  extractStepContext,
  formatLatency,
  type StepTrace,
} from "./extract-step-context";

// ---------------------------------------------------------------------------
// formatLatency
// ---------------------------------------------------------------------------

describe("formatLatency", () => {
  it("formats sub-second latency as integer ms", () => {
    expect(formatLatency(716)).toBe("716ms");
    expect(formatLatency(0)).toBe("0ms");
    expect(formatLatency(999)).toBe("999ms");
  });

  it("formats latency >= 1000 ms as seconds with one decimal", () => {
    expect(formatLatency(1000)).toBe("1.0s");
    expect(formatLatency(1400)).toBe("1.4s");
    expect(formatLatency(10000)).toBe("10.0s");
  });
});

// ---------------------------------------------------------------------------
// extractStepContext — step framing (name / status / latency / error)
// ---------------------------------------------------------------------------

describe("extractStepContext — framing", () => {
  it("includes the step name and status for a passed step", () => {
    const step: StepView = {
      id: "s1",
      name: "fetchData",
      status: "passed",
      latencyMs: 1400,
    };
    const ctx = extractStepContext(step);
    expect(ctx).toContain("Step: fetchData");
    expect(ctx).toContain("Status: passed");
  });

  it("includes formatted latency when present", () => {
    const step: StepView = {
      id: "s1",
      name: "fetchData",
      status: "passed",
      latencyMs: 1400,
    };
    expect(extractStepContext(step)).toContain("Latency: 1.4s");
  });

  it("omits the latency line when latencyMs is absent", () => {
    const step: StepView = { id: "s1", name: "fetchData", status: "running" };
    expect(extractStepContext(step)).not.toContain("Latency:");
  });

  it("includes the error message for a failed step", () => {
    const step: StepView = {
      id: "s2",
      name: "processResult",
      status: "failed",
      latencyMs: 3000,
      error: "Upstream timed out",
    };
    const ctx = extractStepContext(step);
    expect(ctx).toContain("Status: failed");
    expect(ctx).toContain("Error: Upstream timed out");
    expect(ctx).toContain("Latency: 3.0s");
  });

  it("does not include an Error line for a non-failed step even if error is set", () => {
    // Defensive: only surface the error for a genuinely failed step.
    const step: StepView = {
      id: "s1",
      name: "fetchData",
      status: "passed",
      error: "stale artefact",
    };
    expect(extractStepContext(step)).not.toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// extractStepContext — per-step input / output (the rich trace evidence)
// ---------------------------------------------------------------------------

describe("extractStepContext — input/output", () => {
  it("includes the step's input as pretty JSON when the trace carries it", () => {
    const step: StepView = { id: "s1", name: "fetchData", status: "passed" };
    const trace: StepTrace = { input: { url: "https://x.test", limit: 5 } };
    const ctx = extractStepContext(step, trace);
    expect(ctx).toContain("Input:");
    expect(ctx).toContain('"url": "https://x.test"');
    expect(ctx).toContain('"limit": 5');
  });

  it("includes the step's output when the trace carries it", () => {
    const step: StepView = { id: "s1", name: "fetchData", status: "passed" };
    const trace: StepTrace = { output: { records: 42 } };
    const ctx = extractStepContext(step, trace);
    expect(ctx).toContain("Output:");
    expect(ctx).toContain('"records": 42');
  });

  it("passes a string value through verbatim (not JSON-quoted)", () => {
    const step: StepView = { id: "s1", name: "summarize", status: "passed" };
    const trace: StepTrace = { output: "a plain summary line" };
    const ctx = extractStepContext(step, trace);
    expect(ctx).toContain("Output:\na plain summary line");
    expect(ctx).not.toContain('"a plain summary line"');
  });

  it("renders a null input (present but null) rather than omitting it", () => {
    // `undefined` means "absent"; an explicit null IS a value the step saw.
    const step: StepView = { id: "s1", name: "start", status: "passed" };
    const ctx = extractStepContext(step, { input: null });
    expect(ctx).toContain("Input:\nnull");
  });

  it("omits Input/Output when the trace is absent", () => {
    const step: StepView = { id: "s1", name: "fetchData", status: "passed" };
    const ctx = extractStepContext(step);
    expect(ctx).not.toContain("Input:");
    expect(ctx).not.toContain("Output:");
  });

  it("omits Input/Output when the trace carries no values", () => {
    const step: StepView = { id: "s1", name: "fetchData", status: "running" };
    const ctx = extractStepContext(step, {});
    expect(ctx).not.toContain("Input:");
    expect(ctx).not.toContain("Output:");
  });

  it("does not throw on a circular value and still emits the section", () => {
    const step: StepView = { id: "s1", name: "loop", status: "passed" };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ctx = extractStepContext(step, { output: circular });
    expect(ctx).toContain("Output:");
    expect(ctx).toContain("[object Object]");
  });

  it("truncates a very large value and marks the truncation", () => {
    const step: StepView = { id: "s1", name: "big", status: "passed" };
    const huge = "z".repeat(5000);
    const ctx = extractStepContext(step, { output: huge });
    expect(ctx).toContain("… (truncated, 5000 chars total)");
    // The head is kept; the value is not pasted whole.
    expect(ctx).not.toContain(huge);
    expect(ctx).toContain("z".repeat(2000));
  });
});

// ---------------------------------------------------------------------------
// extractStepContext — capability calls made + stub-used
// ---------------------------------------------------------------------------

describe("extractStepContext — capabilities called", () => {
  it("lists the capability calls the step made, in order", () => {
    const step: StepView = { id: "s1", name: "research", status: "passed" };
    const trace: StepTrace = {
      calls: [{ capability: "web.search" }, { capability: "records.write" }],
    };
    const ctx = extractStepContext(step, trace);
    expect(ctx).toContain("Capabilities called:");
    expect(ctx).toContain("- web.search");
    expect(ctx).toContain("- records.write");
    // Order preserved.
    expect(ctx.indexOf("web.search")).toBeLessThan(ctx.indexOf("records.write"));
  });

  it("marks a call served by a stub as (stubbed) and leaves real calls unmarked", () => {
    const step: StepView = { id: "s1", name: "research", status: "passed" };
    const trace: StepTrace = {
      calls: [
        { capability: "web.search", stubUsed: true },
        { capability: "records.write", stubUsed: false },
      ],
    };
    const ctx = extractStepContext(step, trace);
    expect(ctx).toContain("- web.search (stubbed)");
    expect(ctx).toContain("- records.write");
    expect(ctx).not.toContain("records.write (stubbed)");
  });

  it("never emits a provider or model name — only the capability id it is given", () => {
    // The builder must pass the capability id through untouched and add nothing
    // resembling a provider/model. Guard against a regression that enriches
    // with a model name.
    const step: StepView = { id: "s1", name: "generate", status: "passed" };
    const ctx = extractStepContext(step, {
      calls: [{ capability: "models.coding.run", stubUsed: true }],
    });
    expect(ctx).toContain("- models.coding.run (stubbed)");
    expect(ctx).not.toMatch(/gpt|claude|sonnet|opus|gemini|anthropic|openai/i);
  });

  it("falls back to declared capabilities when there is no call trace", () => {
    const step: StepView = { id: "s1", name: "research", status: "pending" };
    const ctx = extractStepContext(step, undefined, {
      capabilities: ["web.search", "records.read"],
    });
    expect(ctx).toContain("Capabilities declared (no call trace):");
    expect(ctx).toContain("- web.search");
    expect(ctx).toContain("- records.read");
  });

  it("prefers runtime calls over declared capabilities when both are present", () => {
    const step: StepView = { id: "s1", name: "research", status: "passed" };
    const ctx = extractStepContext(
      step,
      { calls: [{ capability: "web.search" }] },
      { capabilities: ["records.read"] },
    );
    expect(ctx).toContain("Capabilities called:");
    expect(ctx).not.toContain("Capabilities declared");
    // The declared-only capability is not surfaced when real calls exist.
    expect(ctx).not.toContain("records.read");
  });

  it("omits the capabilities section entirely when neither calls nor declared exist", () => {
    const step: StepView = { id: "s1", name: "noop", status: "passed" };
    expect(extractStepContext(step, { calls: [] }, { capabilities: [] })).not.toContain(
      "Capabilities",
    );
    expect(extractStepContext(step)).not.toContain("Capabilities");
  });
});

// ---------------------------------------------------------------------------
// extractStepContext — run-level stub bookkeeping
// ---------------------------------------------------------------------------

describe("extractStepContext — stub bookkeeping", () => {
  it("surfaces unused stubs (supplied but matched no call)", () => {
    const step: StepView = { id: "s1", name: "research", status: "passed" };
    const trace: StepTrace = {
      calls: [{ capability: "web.search", stubUsed: true }],
      unusedStubs: ["web.serch", "records.reed"],
    };
    const ctx = extractStepContext(step, trace);
    expect(ctx).toContain("Unused stubs (supplied but matched no call):");
    expect(ctx).toContain("- web.serch");
    expect(ctx).toContain("- records.reed");
  });

  it("surfaces stub warnings (right key, wrong shape)", () => {
    const step: StepView = { id: "s1", name: "research", status: "passed" };
    const trace: StepTrace = {
      stubWarnings: ["web.search stub is missing 'results'"],
    };
    const ctx = extractStepContext(step, trace);
    expect(ctx).toContain("Stub warnings:");
    expect(ctx).toContain("- web.search stub is missing 'results'");
  });

  it("omits the stub sections when there are no unused stubs / warnings", () => {
    const step: StepView = { id: "s1", name: "research", status: "passed" };
    const ctx = extractStepContext(step, {
      calls: [{ capability: "web.search", stubUsed: true }],
      unusedStubs: [],
      stubWarnings: [],
    });
    expect(ctx).not.toContain("Unused stubs");
    expect(ctx).not.toContain("Stub warnings:");
  });
});

// ---------------------------------------------------------------------------
// extractStepContext — logs (tail-kept, capped)
// ---------------------------------------------------------------------------

describe("extractStepContext — logs", () => {
  it("includes the logSlice when present", () => {
    const step: StepView = {
      id: "s2",
      name: "processResult",
      status: "passed",
      logSlice: "INFO: processed 42 records",
    };
    const ctx = extractStepContext(step);
    expect(ctx).toContain("Logs:");
    expect(ctx).toContain("INFO: processed 42 records");
  });

  it("does not include a Logs section when logSlice is absent", () => {
    const step: StepView = { id: "s3", name: "finalize", status: "pending" };
    expect(extractStepContext(step)).not.toContain("Logs:");
  });

  it("trims a long logSlice to the cap and keeps the tail (most recent output)", () => {
    const headMarker = "HEAD_IS_TRIMMED";
    const tailMarker = "TAIL_IS_KEPT";
    // headMarker (15) + filler (3000) + tailMarker (12) = 3027 chars.
    // Last 3000 chars drop headMarker and keep tailMarker.
    const longLog = headMarker + "x".repeat(3000) + tailMarker;
    const step: StepView = {
      id: "s4",
      name: "heavyStep",
      status: "running",
      logSlice: longLog,
    };
    const ctx = extractStepContext(step);
    expect(ctx).toContain(tailMarker);
    expect(ctx).not.toContain(headMarker);
    expect(ctx).toContain("Logs:");
  });

  it("does not truncate a logSlice that fits within the cap", () => {
    const shortLog = "short log line\nsecond line";
    const step: StepView = {
      id: "s5",
      name: "quickStep",
      status: "passed",
      logSlice: shortLog,
    };
    expect(extractStepContext(step)).toContain(shortLog);
  });
});

// ---------------------------------------------------------------------------
// extractStepContext — full block integration
// ---------------------------------------------------------------------------

describe("extractStepContext — full block", () => {
  it("assembles framing, input/output, calls, stubs and logs together deterministically", () => {
    const step: StepView = {
      id: "s1",
      name: "research",
      status: "failed",
      latencyMs: 2500,
      error: "no results",
      logSlice: "WARN: empty result set",
    };
    const trace: StepTrace = {
      input: { query: "sapiom" },
      output: { results: [] },
      calls: [{ capability: "web.search", stubUsed: true }],
      unusedStubs: ["web.serch"],
      stubWarnings: ["shape mismatch"],
    };
    const ctx = extractStepContext(step, trace, { capabilities: ["web.search"] });

    // Deterministic for the same inputs.
    expect(ctx).toBe(extractStepContext(step, trace, { capabilities: ["web.search"] }));

    // Every section is present and ordered: framing → IO → calls → stubs → logs.
    const order = [
      "Step: research",
      "Status: failed",
      "Error: no results",
      "Input:",
      "Output:",
      "Capabilities called:",
      "Unused stubs",
      "Stub warnings:",
      "Logs:",
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = ctx.indexOf(marker);
      expect(at, `expected "${marker}" present and in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});
