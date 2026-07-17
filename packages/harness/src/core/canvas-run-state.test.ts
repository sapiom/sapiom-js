import { describe, expect, it } from "vitest";
import { runStateNodeClass } from "./canvas-run-state.js";

/**
 * Unit tests for `runStateNodeClass` — the one pure (DOM-free) function in
 * canvas-run-state.ts. The other two functions (`applyRunStateToCanvas` and
 * `bootCanvasRunState`) operate on a live Document and are not testable in the
 * Node/Vitest environment (no jsdom/happy-dom). Their wiring is verified by
 * `canvas-template.test.ts` (script injection) and manually in a real harness.
 */
describe("runStateNodeClass", () => {
  it('maps "running" to "is-running"', () => {
    expect(runStateNodeClass("running")).toBe("is-running");
  });

  it('maps "passed" to "is-passed"', () => {
    expect(runStateNodeClass("passed")).toBe("is-passed");
  });

  it('maps "failed" to "is-failed"', () => {
    expect(runStateNodeClass("failed")).toBe("is-failed");
  });

  it('maps "pending" to "is-pending"', () => {
    expect(runStateNodeClass("pending")).toBe("is-pending");
  });

  it("maps any unknown status to is-pending (defensive fallback)", () => {
    expect(runStateNodeClass("cancelled")).toBe("is-pending");
    expect(runStateNodeClass("unknown")).toBe("is-pending");
    expect(runStateNodeClass("")).toBe("is-pending");
  });
});
