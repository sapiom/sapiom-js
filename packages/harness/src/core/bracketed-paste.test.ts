import { describe, expect, it } from "vitest";

import {
  PASTE_END,
  PASTE_START,
  initialBracketedPasteState,
  trackBracketedPaste,
  wrapPaste,
} from "./bracketed-paste.js";

const fold = (...chunks: string[]): boolean =>
  chunks.reduce(trackBracketedPaste, initialBracketedPasteState).enabled;

describe("trackBracketedPaste", () => {
  it("is off until the app enables mode 2004", () => {
    expect(initialBracketedPasteState.enabled).toBe(false);
    expect(fold("welcome to the agent\r\n")).toBe(false);
    expect(fold("\x1b[?2004h")).toBe(true);
  });

  it("reads 2004 out of a batched private-mode set, and ignores other modes", () => {
    expect(fold("\x1b[?1049;2004h")).toBe(true);
    expect(fold("\x1b[?1049;1006h")).toBe(false);
    // A mode whose digits merely contain 2004 is a different mode.
    expect(fold("\x1b[?12004h")).toBe(false);
  });

  it("follows the app back off when it resets the mode", () => {
    expect(fold("\x1b[?2004h", "…output…", "\x1b[?2004l")).toBe(false);
    // Last set/reset in a single chunk wins, as the terminal would apply them.
    expect(fold("\x1b[?2004l\x1b[?2004h")).toBe(true);
  });

  it("still sees a sequence that a pty chunk boundary split in half", () => {
    expect(fold("\x1b[?20", "04h")).toBe(true);
    expect(fold("\x1b[?2004h", "\x1b[?2", "004l")).toBe(false);
  });

  it("drops a carry that can no longer be a mode sequence", () => {
    // A long run of text after `ESC[?` is not a pending sequence.
    const state = trackBracketedPaste(initialBracketedPasteState, "\x1b[?" + "x".repeat(64));
    expect(state.carry).toBe("");
    expect(trackBracketedPaste(state, "2004h").enabled).toBe(false);
  });
});

describe("wrapPaste", () => {
  it("brackets the text so its newlines stay content", () => {
    expect(wrapPaste("line one\nline two")).toBe(PASTE_START + "line one\nline two" + PASTE_END);
  });

  it("normalizes carriage returns, which the app would read as Return", () => {
    expect(wrapPaste("a\r\nb\rc")).toBe(PASTE_START + "a\nb\nc" + PASTE_END);
  });

  it("strips an embedded paste terminator that would end the paste early", () => {
    expect(wrapPaste(`ask${PASTE_END} rm -rf /`)).toBe(PASTE_START + "ask rm -rf /" + PASTE_END);
  });
});
