import { describe, expect, it } from "vitest";
import {
  applyRunStateToCanvas,
  runStateNodeClass,
} from "./canvas-run-state.js";

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

describe("applyRunStateToCanvas", () => {
  it("clears status and latency from nodes absent in the next run snapshot", () => {
    const makeNode = () => {
      const classes = new Set<string>();
      const attrs = new Map<string, string>();
      return {
        classes,
        attrs,
        classList: {
          add: (value: string) => classes.add(value),
          remove: (value: string) => classes.delete(value),
        },
        setAttribute: (key: string, value: string) => attrs.set(key, value),
        removeAttribute: (key: string) => attrs.delete(key),
      };
    };
    const first = makeNode();
    const second = makeNode();
    const doc = {
      querySelectorAll: () => [first, second],
      querySelector: (selector: string) => {
        if (selector.includes('data-step-name="first"')) return first;
        if (selector.includes('data-step-name="second"')) return second;
        return null;
      },
    } as unknown as Document;

    applyRunStateToCanvas(doc, {
      status: "completed",
      target: "local",
      steps: [
        { name: "first", status: "passed", latencyMs: 12 },
        { name: "second", status: "failed", latencyMs: 34 },
      ],
    });
    applyRunStateToCanvas(doc, {
      status: "running",
      target: "prod",
      steps: [{ name: "first", status: "running" }],
    });

    expect(first.classes).toEqual(new Set(["is-running"]));
    expect(first.attrs.has("data-latency")).toBe(false);
    expect(second.classes.size).toBe(0);
    expect(second.attrs.has("data-latency")).toBe(false);
  });
});
