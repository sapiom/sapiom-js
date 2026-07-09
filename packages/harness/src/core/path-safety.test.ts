import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { childPath, hasTraversalSegment, resolveWithinRoot } from "./path-safety.js";

describe("childPath", () => {
  const root = path.resolve("/tmp/some-root");

  it("returns the child path for one plain segment", () => {
    expect(childPath(root, "abc")).toBe(path.join(root, "abc"));
  });

  it.each([".", "..", "", "a/b", "../escape", "/absolute"])(
    "rejects %j (not a single in-root segment)",
    (name) => {
      expect(childPath(root, name)).toBeNull();
    },
  );
});

describe("resolveWithinRoot", () => {
  const root = path.resolve("/tmp/canvas-root");

  it("resolves a legitimate nested sub-path", () => {
    expect(resolveWithinRoot(root, "renders/flow.html")).toBe(path.join(root, "renders", "flow.html"));
  });

  it("treats the root itself as inside", () => {
    expect(resolveWithinRoot(root, ".")).toBe(root);
  });

  it("normalizes an in-root path that uses .. internally without escaping", () => {
    expect(resolveWithinRoot(root, "renders/../index.html")).toBe(path.join(root, "index.html"));
  });

  it("rejects a .. climb that escapes the root", () => {
    expect(resolveWithinRoot(root, "../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute path pointing outside the root", () => {
    expect(resolveWithinRoot(root, "/etc/passwd")).toBeNull();
  });

  it("rejects a sibling directory sharing the root's name prefix", () => {
    // `${root}-evil` must not count as inside `${root}` — the classic
    // prefix-string containment bug the path.relative check avoids.
    expect(resolveWithinRoot(root, path.resolve(`${root}-evil`, "file"))).toBeNull();
  });
});

describe("resolveWithinRoot with symlinks", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-path-safety-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps a symlink target that points back inside the root as inside (lexical check)", async () => {
    const root = path.join(dir, "root");
    await fs.mkdir(path.join(root, "real"), { recursive: true });
    await fs.symlink(path.join(root, "real"), path.join(root, "link"));
    // The guard is lexical: `root/link` is under root by name, regardless of
    // where the symlink points. Callers that must not follow links out of the
    // root pair this with a non-following readdir/lstat (as the sinks do).
    expect(resolveWithinRoot(root, "link")).toBe(path.join(root, "link"));
  });

  it("rejects an absolute path to a symlink that lives outside the root", async () => {
    const root = path.join(dir, "root");
    const outside = path.join(dir, "outside");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(dir, "escape-link"));
    expect(resolveWithinRoot(root, path.join(dir, "escape-link"))).toBeNull();
  });
});

describe("hasTraversalSegment", () => {
  it.each(["..", "../a", "a/..", "a/../b", "/abs/../x", "a\\..\\b"])(
    "detects a %j traversal segment",
    (p) => {
      expect(hasTraversalSegment(p)).toBe(true);
    },
  );

  it.each(["/a/b/c", "a/b", "a..b", "..foo", "foo..", "/tmp/my..project/x"])(
    "does not flag %j (no traversal segment)",
    (p) => {
      expect(hasTraversalSegment(p)).toBe(false);
    },
  );

  it("never flags a fully resolved absolute path", () => {
    expect(hasTraversalSegment(path.resolve("/tmp/a/../b/./c"))).toBe(false);
  });
});
