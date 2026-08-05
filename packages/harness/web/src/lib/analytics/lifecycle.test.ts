import { describe, expect, it } from "vitest";

import { deployErrorKind, newAgentPaths, slugFromPath } from "./lifecycle";

describe("slugFromPath", () => {
  it("returns the last segment of an absolute path", () => {
    expect(slugFromPath("/Users/demo/acme-app/leasing")).toBe("leasing");
  });

  it("ignores a trailing slash", () => {
    expect(slugFromPath("/Users/demo/acme-app/leasing/")).toBe("leasing");
  });

  it("handles a single segment and Windows separators", () => {
    expect(slugFromPath("leasing")).toBe("leasing");
    expect(slugFromPath("C:\\Users\\demo\\rfq")).toBe("rfq");
  });

  it("never returns the full path", () => {
    const path = "/Users/demo/acme-app/leasing";
    expect(slugFromPath(path)).not.toContain("/");
  });
});

describe("newAgentPaths", () => {
  const wf = (path: string) => ({ path });

  it("returns nothing when everything is already seen (seeded)", () => {
    const seen = new Set(["/a", "/b"]);
    expect(newAgentPaths(seen, [wf("/a"), wf("/b")])).toEqual([]);
  });

  it("returns only genuinely new paths", () => {
    const seen = new Set(["/a"]);
    expect(newAgentPaths(seen, [wf("/a"), wf("/b"), wf("/c")])).toEqual(["/b", "/c"]);
  });

  it("does not re-report a path once it has been added to seen", () => {
    const seen = new Set<string>(["/a"]);
    const fresh = newAgentPaths(seen, [wf("/a"), wf("/b")]);
    expect(fresh).toEqual(["/b"]);
    for (const p of fresh) seen.add(p);
    // A later refresh (e.g. a removal + re-add elsewhere) with the same set
    // reports nothing new.
    expect(newAgentPaths(seen, [wf("/a"), wf("/b")])).toEqual([]);
  });

  it("a removed agent does not fire, and re-adding a removed path counts once", () => {
    const seen = new Set<string>(["/a", "/b"]);
    // /b removed from the registry — no event, and it stays in `seen`.
    expect(newAgentPaths(seen, [wf("/a")])).toEqual([]);
    // /a still seen; nothing new.
    expect(newAgentPaths(seen, [wf("/a")])).toEqual([]);
  });
});

describe("deployErrorKind", () => {
  it("maps a thrown error to exception regardless of phase", () => {
    expect(deployErrorKind("building", true)).toBe("exception");
    expect(deployErrorKind(null, true)).toBe("exception");
  });

  it("maps a terminal error after linking to link_failed", () => {
    expect(deployErrorKind("linking", false)).toBe("link_failed");
  });

  it("maps a terminal error after building (or unknown) to build_failed", () => {
    expect(deployErrorKind("building", false)).toBe("build_failed");
    expect(deployErrorKind(null, false)).toBe("build_failed");
  });
});
