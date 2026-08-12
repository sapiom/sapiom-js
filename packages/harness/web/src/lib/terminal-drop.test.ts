/**
 * The drop payload is what a native terminal would type for a dropped file:
 * quoted only when needed, space separated, trailing space. The interesting
 * cases are the ones that reach a real CLI parser — spaces, quotes, Windows
 * paths — and the degenerate one where the bridge resolved nothing (a File
 * synthesized by the page has no path), which must paste nothing at all.
 */
import { describe, expect, it } from "vitest";

import { dropPayload, quotePathForTerminal } from "./terminal-drop";

describe("quotePathForTerminal", () => {
  it("leaves a plain POSIX path bare", () => {
    expect(quotePathForTerminal("/Users/x/shot.png")).toBe("/Users/x/shot.png");
  });

  it("leaves a Windows path bare — backslashes and the drive colon are safe", () => {
    expect(quotePathForTerminal("C:\\Users\\x\\shot.png")).toBe("C:\\Users\\x\\shot.png");
  });

  it("double-quotes a path with spaces", () => {
    expect(quotePathForTerminal("/Users/x/My Shots/a b.png")).toBe('"/Users/x/My Shots/a b.png"');
  });

  it("escapes an embedded double quote inside the quoting", () => {
    expect(quotePathForTerminal('/tmp/say "hi".png')).toBe('"/tmp/say \\"hi\\".png"');
  });

  it("quotes shell-special characters, not just spaces", () => {
    expect(quotePathForTerminal("/tmp/a&b.png")).toBe('"/tmp/a&b.png"');
  });
});

describe("dropPayload", () => {
  it("joins multiple paths with spaces and ends with a trailing space", () => {
    expect(dropPayload(["/a.png", "/b dir/c.png"])).toBe('/a.png "/b dir/c.png" ');
  });

  it("skips paths the bridge couldn't resolve", () => {
    expect(dropPayload(["", "/a.png", ""])).toBe("/a.png ");
  });

  it("returns null when nothing resolved — the caller must paste nothing", () => {
    expect(dropPayload([])).toBeNull();
    expect(dropPayload(["", ""])).toBeNull();
  });
});
