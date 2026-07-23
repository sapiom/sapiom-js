import { describe, it, expect } from "vitest";

import { parseRunLocalLine, splitNdjson } from "./api";

describe("splitNdjson — incremental (flush=false)", () => {
  it("returns complete lines and holds the unterminated remainder", () => {
    const { lines, rest } = splitNdjson('{"a":1}\n{"b":2}\n{"c":3', false);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":3'); // partial last line kept for the next chunk
  });

  it("keeps an empty remainder when the buffer ends exactly on a newline", () => {
    const { lines, rest } = splitNdjson('{"a":1}\n', false);
    expect(lines).toEqual(['{"a":1}']);
    expect(rest).toBe("");
  });

  it("holds a whole line back until its newline arrives (no premature emit)", () => {
    const { lines, rest } = splitNdjson('{"a":1}', false);
    expect(lines).toEqual([]);
    expect(rest).toBe('{"a":1}');
  });

  it("drops blank lines between records", () => {
    const { lines } = splitNdjson('{"a":1}\n\n{"b":2}\n', false);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("splitNdjson — flush (end of stream)", () => {
  it("treats the whole buffer as complete, including a final unterminated line", () => {
    const { lines, rest } = splitNdjson('{"a":1}\n{"b":2}', true);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe(""); // nothing left pending at end of stream
  });

  it("yields no lines for an empty flush", () => {
    expect(splitNdjson("", true)).toEqual({ lines: [], rest: "" });
  });
});

describe("parseRunLocalLine", () => {
  it("parses a per-step trace line (no kind discriminant)", () => {
    const line = parseRunLocalLine('{"step":"gather","attempt":1,"input":{},"status":"succeeded","logs":[]}');
    expect(line).toMatchObject({ step: "gather", status: "succeeded" });
    expect(line && "kind" in line ? line.kind : undefined).toBeUndefined();
  });

  it("parses a terminal summary line", () => {
    const line = parseRunLocalLine('{"kind":"summary","outcome":"completed","unusedStubs":[],"stubWarnings":[]}');
    expect(line).toEqual({ kind: "summary", outcome: "completed", unusedStubs: [], stubWarnings: [] });
  });

  it("parses a terminal error line", () => {
    const line = parseRunLocalLine('{"kind":"error","outcome":"failed","error":"bad project"}');
    expect(line).toEqual({ kind: "error", outcome: "failed", error: "bad project" });
  });

  it("returns null for non-JSON noise (an esbuild banner, a stray console write)", () => {
    expect(parseRunLocalLine("Build succeeded in 12ms")).toBeNull();
  });

  it("returns null for a blank line", () => {
    expect(parseRunLocalLine("   ")).toBeNull();
  });

  it("returns null for a JSON non-object (a bare array or scalar)", () => {
    expect(parseRunLocalLine("[1,2,3]")).toBeNull();
    expect(parseRunLocalLine("42")).toBeNull();
  });
});
