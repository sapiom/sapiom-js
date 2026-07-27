import { describe, expect, it } from "vitest";
import {
  FALLBACK_PROJECT_NAME,
  isValidProjectName,
  nextAvailableName,
  parentOf,
  projectDirSuggestion,
  resolveProjectRoot,
  slugifyIdea,
} from "./project-dir";

describe("isValidProjectName", () => {
  it.each(["a", "price-watch", "agent2", "a-2", "x".repeat(214)])("accepts %s", (name) => {
    expect(isValidProjectName(name)).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["Price-Watch", "uppercase — npm rejects it"],
    ["-leading", "leading dash"],
    ["_leading", "leading underscore"],
    ["has space", "space"],
    ["has/slash", "path separator"],
    ["dot.name", "dot"],
    ["émoji", "non-ascii"],
    ["x".repeat(215), "over npm's 214-char cap"],
  ])("rejects %s (%s)", (name) => {
    expect(isValidProjectName(name)).toBe(false);
  });
});

describe("slugifyIdea", () => {
  it("drops filler and cadence words, keeping the identity", () => {
    expect(slugifyIdea("Every morning, diff our competitors' pricing pages and Slack me")).toBe(
      "diff-competitors-pricing",
    );
  });

  it("keeps at most three words", () => {
    expect(slugifyIdea("alpha beta gamma delta epsilon")).toBe("alpha-beta-gamma");
  });

  it("truncates on a word boundary, never mid-word or with a trailing dash", () => {
    const slug = slugifyIdea("reconciliation orchestration synchronization");
    expect(slug).toBe("reconciliation-orchestration");
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("still yields a valid name when a single word blows the budget", () => {
    const slug = slugifyIdea("supercalifragilisticexpialidociousness");
    expect(isValidProjectName(slug)).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  it("falls back to stopwords rather than the generic name when that is all there is", () => {
    // A poor name, but more use than `sapiom-agent`.
    expect(slugifyIdea("every day")).toBe("every-day");
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["!!! ??? ---", "punctuation only"],
    ["🎉🎉", "emoji only"],
    ["日本語のみ", "unsupported script"],
  ])("falls back to the generic name for %s (%s)", (idea) => {
    expect(slugifyIdea(idea)).toBe(FALLBACK_PROJECT_NAME);
  });

  it("never returns a name that would be rejected downstream", () => {
    for (const idea of [
      "UPPERCASE IDEA",
      "-leading dashes-",
      "123 numbers first",
      "mixed_underscores and.dots",
      "a",
    ]) {
      expect(isValidProjectName(slugifyIdea(idea))).toBe(true);
    }
  });
});

describe("projectDirSuggestion", () => {
  it("joins root and name", () => {
    expect(projectDirSuggestion("price-watch", "/Users/demo/acme-app")).toBe(
      "/Users/demo/acme-app/price-watch",
    );
  });

  it("does not double the separator when the root has a trailing slash", () => {
    expect(projectDirSuggestion("price-watch", "/Users/demo/")).toBe("/Users/demo/price-watch");
  });

  it.each([
    ["price-watch", null],
    ["price-watch", ""],
    ["", "/Users/demo"],
    ["   ", "/Users/demo"],
  ])("returns empty when either side is missing (%s, %s)", (name, root) => {
    expect(projectDirSuggestion(name, root)).toBe("");
  });
});

describe("resolveProjectRoot", () => {
  it("prefers the user's saved setting", () => {
    expect(
      resolveProjectRoot({
        settingsRoot: "/Users/demo/work",
        defaultProjectRoot: "/host/default",
        launchDir: "/launch",
      }),
    ).toBe("/Users/demo/work");
  });

  it("falls back to the host default when nothing is saved", () => {
    expect(
      resolveProjectRoot({ settingsRoot: null, defaultProjectRoot: "/host/default", launchDir: "/launch" }),
    ).toBe("/host/default");
  });

  it("falls back to the launch dir when the host supplied no default", () => {
    expect(resolveProjectRoot({ launchDir: "/launch" })).toBe("/launch");
  });

  it("treats blank values as absent rather than as a root", () => {
    expect(
      resolveProjectRoot({ settingsRoot: "   ", defaultProjectRoot: "", launchDir: "/launch" }),
    ).toBe("/launch");
  });

  it("returns empty when it has nothing to go on", () => {
    expect(resolveProjectRoot({})).toBe("");
  });
});

describe("parentOf", () => {
  it.each([
    ["/Users/demo/acme-app", "/Users/demo"],
    ["/Users/demo/acme-app/", "/Users/demo"],
    ["/Users/demo", "/Users"],
    ["/Users", "/"],
  ])("%s → %s", (input, expected) => {
    expect(parentOf(input)).toBe(expected);
  });

  it.each([["/"], [""], ["relative"]])("returns null at the top for %s", (input) => {
    expect(parentOf(input)).toBeNull();
  });
});

describe("nextAvailableName", () => {
  it("returns the base when it is free", () => {
    expect(nextAvailableName("price-watch", ["other"])).toBe("price-watch");
  });

  it("suffixes past every taken name in the series", () => {
    expect(nextAvailableName("price-watch", ["price-watch", "price-watch-2"])).toBe("price-watch-3");
  });

  it("always produces a valid name", () => {
    expect(isValidProjectName(nextAvailableName("agent", ["agent"]))).toBe(true);
  });
});
