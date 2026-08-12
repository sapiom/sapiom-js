import { describe, expect, it } from "vitest";
import {
  basenameOf,
  isWithinDir,
  joinPath,
  looksAbsolutePath,
  middleTruncatePath,
  parentOf,
  sepOf,
  stripTrailingSep,
} from "./paths";

describe("sepOf", () => {
  it.each([
    ["/Users/demo", "/"],
    ["C:\\Users\\demo", "\\"],
    // Mixed form — what the browser's own `/`-joins used to produce. Any `\`
    // marks the path as Windows-born, so further joins stay native.
    ["C:\\Users\\demo/projects", "\\"],
    ["relative", "/"],
  ] as const)("%s → %s", (input, expected) => {
    expect(sepOf(input)).toBe(expected);
  });
});

describe("joinPath", () => {
  it("joins POSIX with /", () => {
    expect(joinPath("/Users/demo", "price-watch")).toBe("/Users/demo/price-watch");
  });

  it("joins Windows with \\ — the headline fix, no mixed-separator output", () => {
    expect(joinPath("C:\\Users\\demo\\projects", "newsletter-autopilot")).toBe(
      "C:\\Users\\demo\\projects\\newsletter-autopilot",
    );
  });

  it("never doubles a trailing separator, either kind", () => {
    expect(joinPath("/Users/demo/", "a")).toBe("/Users/demo/a");
    expect(joinPath("C:\\Users\\demo\\", "a")).toBe("C:\\Users\\demo\\a");
  });

  it("trims whitespace on both sides", () => {
    expect(joinPath("  /Users/demo  ", "  a  ")).toBe("/Users/demo/a");
  });

  it("keeps a drive root joinable", () => {
    expect(joinPath("C:\\", "a")).toBe("C:\\a");
  });
});

describe("basenameOf", () => {
  it.each([
    ["/a/b", "b"],
    ["/a/b/", "b"],
    ["C:\\a\\b", "b"],
    ["C:\\a\\b/c", "c"], // mixed — the shipped bug's shape
    ["name-only", "name-only"],
  ])("%s → %s", (input, expected) => {
    expect(basenameOf(input)).toBe(expected);
  });
});

describe("parentOf", () => {
  it.each([
    ["/a/b", "/a"],
    ["/a/b/", "/a"],
    ["/a", "/"], // first-level POSIX keeps its root spelled out
    ["C:\\a\\b", "C:\\a"],
    ["C:\\a", "C:\\"], // first-level Windows likewise
    ["C:\\a\\b/c", "C:\\a\\b"], // mixed: cut at the LAST separator of either kind
  ])("%s → %s", (input, expected) => {
    expect(parentOf(input)).toBe(expected);
  });

  it.each([["/"], ["C:\\"], ["C:"], [""], ["relative"]])(
    "returns null at the top for %s",
    (input) => {
      expect(parentOf(input)).toBeNull();
    },
  );
});

describe("stripTrailingSep", () => {
  it.each([
    ["/a/b/", "/a/b"],
    ["/a/b//", "/a/b"],
    ["C:\\a\\", "C:\\a"],
    ["/a/b", "/a/b"],
  ])("%s → %s", (input, expected) => {
    expect(stripTrailingSep(input)).toBe(expected);
  });

  it("preserves bare roots — stripping them would leave a non-path", () => {
    expect(stripTrailingSep("/")).toBe("/");
    expect(stripTrailingSep("C:\\")).toBe("C:\\");
  });
});

describe("isWithinDir", () => {
  it("matches identity and descendants on POSIX", () => {
    expect(isWithinDir("/a/b", "/a/b")).toBe(true);
    expect(isWithinDir("/a/b", "/a/b/c")).toBe(true);
    expect(isWithinDir("/a/b", "/a/other")).toBe(false);
  });

  it("never matches a mere string prefix", () => {
    expect(isWithinDir("/a/scratch", "/a/scratch-2")).toBe(false);
    expect(isWithinDir("C:\\a\\scratch", "C:\\a\\scratch-2")).toBe(false);
  });

  it("matches on Windows paths", () => {
    expect(isWithinDir("C:\\a\\b", "C:\\a\\b\\c")).toBe(true);
    expect(isWithinDir("C:\\a\\b", "C:\\a\\other")).toBe(false);
  });

  it("matches a mixed-separator child against its native parent — the shipped bug", () => {
    expect(isWithinDir("C:\\Users\\x\\projects", "C:\\Users\\x\\projects/newsletter-autopilot")).toBe(
      true,
    );
    expect(isWithinDir("C:\\Users\\x\\projects/app", "C:\\Users\\x\\projects\\app")).toBe(true);
  });

  it("ignores trailing separators on either side", () => {
    expect(isWithinDir("/a/b/", "/a/b/c")).toBe(true);
    expect(isWithinDir("C:\\a\\b\\", "C:\\a\\b\\c")).toBe(true);
  });
});

describe("looksAbsolutePath", () => {
  it.each([["/Users"], ["~/work"], ["C:\\Users"], ["C:/Users"], ["d:\\x"]])(
    "accepts %s",
    (input) => {
      expect(looksAbsolutePath(input)).toBe(true);
    },
  );

  it.each([["query text"], ["price-watch"], ["C:"], ["cat: something"]])(
    "rejects %s",
    (input) => {
      expect(looksAbsolutePath(input)).toBe(false);
    },
  );
});

describe("middleTruncatePath", () => {
  it("middle-truncates a long POSIX path", () => {
    expect(middleTruncatePath("/Users/demo/work/onboarding-flow")).toBe("/Users/…/onboarding-flow");
  });

  it("middle-truncates a Windows path in its own separator", () => {
    expect(middleTruncatePath("C:\\Users\\demo\\work\\onboarding-flow")).toBe(
      "C:\\…\\onboarding-flow",
    );
  });

  it("leaves short paths alone", () => {
    expect(middleTruncatePath("/Users/demo")).toBe("/Users/demo");
    expect(middleTruncatePath("C:\\Users")).toBe("C:\\Users");
  });
});
