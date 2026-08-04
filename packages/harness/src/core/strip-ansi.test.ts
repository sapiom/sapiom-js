import { describe, it, expect } from "vitest";

import { stripAnsi } from "./strip-ansi.js";

describe("stripAnsi", () => {
  it("removes SGR colour/style sequences, keeping the text", () => {
    expect(stripAnsi("\x1b[31merror\x1b[0m: boom")).toBe("error: boom");
  });

  it("removes cursor-addressing (CSI) sequences", () => {
    // Codex renders words positioned by cursor moves with no literal spaces.
    expect(stripAnsi("trust\x1b[3;16Hthe\x1b[3;20Hcontents")).toBe("trustthecontents");
  });

  it("removes an OSC window-title sequence without swallowing later text", () => {
    // The lazy match must stop at the FIRST terminator, not consume through a
    // much-later one — otherwise real output after the sequence disappears.
    expect(stripAnsi("\x1b]0;my title\x07real output")).toBe("real output");
  });

  it("removes charset/keypad-mode selects", () => {
    expect(stripAnsi("\x1b(Bplain")).toBe("plain");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });
});
