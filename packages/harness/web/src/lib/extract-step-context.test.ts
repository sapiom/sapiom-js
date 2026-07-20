/**
 * Unit tests for `extractStepContext` and `formatLatency`.
 *
 * Pure, DOM-free — runs under vitest node. Tests verify the happy path, error
 * path, the missing-logs case, and the long-logs tail-keep truncation.
 */
import { describe, expect, it } from "vitest";
import type { StepView } from "@shared/types";

import { extractStepContext, formatLatency } from "./extract-step-context";

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
// extractStepContext — happy path (passed step)
// ---------------------------------------------------------------------------

describe("extractStepContext", () => {
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
    const ctx = extractStepContext(step);
    expect(ctx).toContain("Latency: 1.4s");
  });

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

  // ---------------------------------------------------------------------------
  // failed step — error is included
  // ---------------------------------------------------------------------------

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

  it("does not include an Error line for a non-failed step even if error field is set", () => {
    // Defensive: the UI should only show the error for genuinely failed steps.
    const step: StepView = {
      id: "s1",
      name: "fetchData",
      status: "passed",
      error: "stale artefact",
    };
    const ctx = extractStepContext(step);
    expect(ctx).not.toContain("Error:");
  });

  // ---------------------------------------------------------------------------
  // Step with no logs
  // ---------------------------------------------------------------------------

  it("does not include a Logs section when logSlice is absent", () => {
    const step: StepView = {
      id: "s3",
      name: "finalize",
      status: "pending",
    };
    const ctx = extractStepContext(step);
    expect(ctx).not.toContain("Logs:");
  });

  // ---------------------------------------------------------------------------
  // Long logs — tail-kept truncation
  // ---------------------------------------------------------------------------

  it("trims a long logSlice to the cap and keeps the tail (most recent output)", () => {
    // Build a log where the HEAD is a unique marker that should be trimmed away,
    // and the TAIL is another unique marker that must survive.
    const headMarker = "HEAD_IS_TRIMMED";
    const tailMarker = "TAIL_IS_KEPT";
    // Total length: headMarker (15) + filler (3000) + tailMarker (12) = 3027 chars
    // After trim to LOG_CAP (3000): the last 3000 chars = filler[15..] + tailMarker
    // headMarker is gone, tailMarker survives.
    const longLog = headMarker + "x".repeat(3000) + tailMarker;
    const step: StepView = {
      id: "s4",
      name: "heavyStep",
      status: "running",
      logSlice: longLog,
    };
    const ctx = extractStepContext(step);
    // The tail must be present.
    expect(ctx).toContain(tailMarker);
    // The head (beginning of the original log) must have been trimmed away.
    expect(ctx).not.toContain(headMarker);

    // The Logs section itself must still be present.
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
    const ctx = extractStepContext(step);
    expect(ctx).toContain(shortLog);
  });
});
