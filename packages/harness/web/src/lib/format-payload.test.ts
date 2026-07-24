import { describe, expect, it } from "vitest";

import { formatPayload } from "./format-payload";

describe("formatPayload", () => {
  it("passes a plain string through unquoted", () => {
    // A string is already legible — no JSON quotes around it.
    expect(formatPayload("hello world")).toBe("hello world");
    expect(formatPayload("")).toBe("");
  });

  it("pretty-prints objects with two-space indentation", () => {
    expect(formatPayload({ a: 1, b: "two" })).toBe('{\n  "a": 1,\n  "b": "two"\n}');
  });

  it("pretty-prints arrays", () => {
    expect(formatPayload([1, 2, 3])).toBe("[\n  1,\n  2,\n  3\n]");
  });

  it("renders nested structures with indentation", () => {
    expect(formatPayload({ outer: { inner: [true] } })).toBe(
      '{\n  "outer": {\n    "inner": [\n      true\n    ]\n  }\n}',
    );
  });

  // Honesty rule: a captured value the caller chose to render (input/output
  // !== undefined) is shown faithfully — falsy JSON values are real values,
  // never swallowed.
  it("renders a real null faithfully", () => {
    expect(formatPayload(null)).toBe("null");
  });

  it("renders a real false faithfully", () => {
    expect(formatPayload(false)).toBe("false");
  });

  it("renders a real zero faithfully", () => {
    expect(formatPayload(0)).toBe("0");
  });

  it("renders numbers as JSON, not the empty string", () => {
    expect(formatPayload(42)).toBe("42");
    expect(formatPayload(-1.5)).toBe("-1.5");
  });

  it("falls back to String() for a circular reference instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // JSON.stringify throws on a cycle; we must not — the inspector still
    // shows *something* for a step it observed.
    expect(() => formatPayload(circular)).not.toThrow();
    expect(formatPayload(circular)).toBe("[object Object]");
  });

  it("falls back to String() for a BigInt instead of throwing", () => {
    // JSON.stringify throws on BigInt; String() renders it.
    expect(() => formatPayload(10n)).not.toThrow();
    expect(formatPayload(10n)).toBe("10");
  });

  it("falls back to String() for a value with no JSON form, never the text 'undefined'", () => {
    // JSON.stringify returns `undefined` for a function; the `?? String(value)`
    // fallback must kick in. Asserting the exact String() form (not merely
    // "!== 'undefined'") catches a dropped fallback branch.
    const fn = (): number => 1;
    expect(formatPayload(fn)).toBe(String(fn));
  });
});
