import { describe, it, expect } from "vitest";

import { formatLogEntry, toLogSlice, LOG_SLICE_MAX } from "./render-log-slice.js";

describe("formatLogEntry", () => {
  it("returns a bare string entry unchanged", () => {
    expect(formatLogEntry("just a line")).toBe("just a line");
  });

  it("returns an empty string for an empty-string entry (the string branch, not stringified)", () => {
    // Kills the `typeof entry === "string"` guard mutants: a "" entry must come
    // straight back as "", NOT the String("") of some other branch.
    expect(formatLogEntry("")).toBe("");
  });

  it("joins ts + level + msg from an object entry", () => {
    expect(formatLogEntry({ ts: "t0", level: "info", msg: "start" })).toBe("t0 info start");
  });

  it("falls back to `message` when `msg` is absent", () => {
    expect(formatLogEntry({ ts: "t1", level: "error", message: "kaboom" })).toBe("t1 error kaboom");
  });

  it("prefers `msg` over `message` when both are present", () => {
    expect(formatLogEntry({ level: "info", msg: "chosen", message: "ignored" })).toBe("info chosen");
  });

  it("keeps numeric fields (e.g. a ms epoch ts), stringifying them", () => {
    expect(formatLogEntry({ ts: 1700000000000, level: "info", msg: "boot" })).toBe("1700000000000 info boot");
  });

  it("drops non-string/number fields rather than printing 'undefined'", () => {
    // level is an object here → filtered out; only the string msg survives.
    expect(formatLogEntry({ level: { nested: true }, msg: "only-msg" })).toBe("only-msg");
  });

  it("stringifies an object with NO usable ts/level/msg/message fields (empty parts → fallback)", () => {
    // parts.length is 0 → the `> 0` guard is false → String(entry) fallback.
    // Kills the `parts.length > 0` → `>= 0`/`true` mutants (they would wrongly
    // return "" from an empty join instead of the stringified object).
    const out = formatLogEntry({ irrelevant: 1 });
    expect(out).toBe("[object Object]");
    expect(out).not.toBe("");
  });

  it("stringifies a null entry (not treated as an object)", () => {
    // Kills the `entry !== null && ...` operand mutants: null must fall through
    // to String(null), not be indexed as an object.
    expect(formatLogEntry(null)).toBe("null");
  });

  it("stringifies a number entry", () => {
    expect(formatLogEntry(42)).toBe("42");
  });
});

describe("toLogSlice", () => {
  it("returns undefined for a non-array", () => {
    expect(toLogSlice(null)).toBeUndefined();
    expect(toLogSlice("not an array")).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(toLogSlice([])).toBeUndefined();
  });

  it("joins entries with newlines", () => {
    expect(toLogSlice(["one", "two", "three"])).toBe("one\ntwo\nthree");
  });

  it("returns undefined when the joined text is only whitespace (trim → empty)", () => {
    // Kills the `.trim()` removal and the `text === ""` guard mutants: a log of
    // blank strings must be treated as "no usable logs", not an empty slice.
    expect(toLogSlice(["", "   ", ""])).toBeUndefined();
  });

  it("trims surrounding whitespace off the joined text", () => {
    expect(toLogSlice(["  padded  "])).toBe("padded");
  });

  it("returns the whole text unchanged when it is exactly at the cap (boundary)", () => {
    // length === LOG_SLICE_MAX must NOT slice (kills the `> ` → `>= ` mutant).
    const exact = "x".repeat(LOG_SLICE_MAX);
    const out = toLogSlice([exact]) as string;
    expect(out.length).toBe(LOG_SLICE_MAX);
    expect(out).toBe(exact);
  });

  it("keeps the TAIL (drops the oldest chars) when the text exceeds the cap", () => {
    const over = "a".repeat(LOG_SLICE_MAX) + "TAIL";
    const out = toLogSlice([over]) as string;
    expect(out.length).toBe(LOG_SLICE_MAX);
    expect(out.endsWith("TAIL")).toBe(true); // newest survives
    expect(out.startsWith("a")).toBe(true); // some leading a's remain, but trimmed
    // Exactly LOG_SLICE_MAX chars kept from the END: "TAIL" (4) + (MAX-4) a's.
    expect(out).toBe("a".repeat(LOG_SLICE_MAX - 4) + "TAIL");
  });
});
