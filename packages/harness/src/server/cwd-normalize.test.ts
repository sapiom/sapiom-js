import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCwd } from "./cwd-normalize.js";

describe("normalizeCwd", () => {
  it("collapses the mixed-separator path the browser used to build", () => {
    // The shipped bug: a Windows projects root joined with "/" in the SPA.
    expect(normalizeCwd("C:\\Users\\x\\.sapiom\\harness\\projects/newsletter-autopilot", win32)).toBe(
      "C:\\Users\\x\\.sapiom\\harness\\projects\\newsletter-autopilot",
    );
  });

  it("normalizes traversal and duplicate separators per platform", () => {
    expect(normalizeCwd("C:\\a\\b\\..\\c//d", win32)).toBe("C:\\a\\c\\d");
    expect(normalizeCwd("/a/b/../c//d", posix)).toBe("/a/c/d");
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(normalizeCwd("  /a/b  ", posix)).toBe("/a/b");
  });

  it("leaves an all-whitespace value alone for the schema/caller to reject", () => {
    expect(normalizeCwd("   ")).toBe("   ".trim());
  });

  it("keeps a clean POSIX path unchanged", () => {
    expect(normalizeCwd("/Users/x/projects/foo", posix)).toBe("/Users/x/projects/foo");
  });
});
