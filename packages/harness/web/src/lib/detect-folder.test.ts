import { describe, expect, it, vi } from "vitest";

import type { FsDirEntry, FsListResponse } from "./api";
import { classifyFolder } from "./detect-folder";

function entry(path: string, hasAgentProject = false): FsDirEntry {
  return { name: path.split("/").filter(Boolean).pop() ?? path, path, hasAgentProject };
}

function listing(path: string, children: { path: string; agent?: boolean }[] = []): FsListResponse {
  return {
    path,
    parent: path.slice(0, path.lastIndexOf("/")) || "/",
    dirs: children.map((c) => entry(c.path, c.agent ?? false)),
  };
}

/** A listDir that resolves the mapped paths and rejects everything else (an
 *  unreadable directory), so tests describe only the listings that exist. */
function makeListDir(map: Record<string, FsListResponse>): (path?: string) => Promise<FsListResponse> {
  return vi.fn((path?: string) => {
    const res = map[path ?? ""];
    return res ? Promise.resolve(res) : Promise.reject(new Error(`no listing for ${path}`));
  });
}

describe("classifyFolder", () => {
  it("reports a new folder from the picker's isNew flag without touching the fs", async () => {
    const listDir = vi.fn();
    expect(await classifyFolder("/a/b/newproj", true, listDir)).toEqual({ kind: "new" });
    expect(listDir).not.toHaveBeenCalled();
  });

  it("recognises the target itself as an agent project (via its parent's listing)", async () => {
    const listDir = makeListDir({ "/a": listing("/a", [{ path: "/a/b", agent: true }]) });
    expect(await classifyFolder("/a/b", false, listDir)).toEqual({ kind: "project" });
  });

  it("normalises a trailing slash before the parent-listing comparison", async () => {
    const listDir = makeListDir({ "/a": listing("/a", [{ path: "/a/b", agent: true }]) });
    expect(await classifyFolder("/a/b/", false, listDir)).toEqual({ kind: "project" });
  });

  it("counts agent projects contained under a plain folder", async () => {
    const listDir = makeListDir({
      "/a": listing("/a", [{ path: "/a/b" }]),
      "/a/b": listing("/a/b", [{ path: "/a/b/x", agent: true }, { path: "/a/b/y", agent: true }, { path: "/a/b/z" }]),
    });
    expect(await classifyFolder("/a/b", false, listDir)).toEqual({ kind: "multi", found: 2 });
  });

  it("reports a plain folder when nothing inside is an agent project", async () => {
    const listDir = makeListDir({
      "/a": listing("/a", [{ path: "/a/b" }]),
      "/a/b": listing("/a/b", [{ path: "/a/b/x" }]),
    });
    expect(await classifyFolder("/a/b", false, listDir)).toEqual({ kind: "plain" });
  });

  it("treats a target that resolves to an ancestor as a new folder (mock's behaviour)", async () => {
    const listDir = makeListDir({
      "/a/b": listing("/a/b", [{ path: "/a/b/x" }]),
      // The mock resolves the missing tail up to its ancestor: path !== target.
      "/a/b/newproj": { path: "/a/b", parent: "/a", dirs: [] },
    });
    expect(await classifyFolder("/a/b/newproj", false, listDir)).toEqual({ kind: "new" });
  });

  it("treats an unreadable target with a readable parent as new (real server's 404)", async () => {
    const listDir = makeListDir({ "/a": listing("/a", [{ path: "/a/b" }]) }); // "/a/b" rejects
    expect(await classifyFolder("/a/b", false, listDir)).toEqual({ kind: "new" });
  });

  it("throws when neither the target nor its parent can be read", async () => {
    const listDir = makeListDir({}); // everything rejects
    await expect(classifyFolder("/a/b", false, listDir)).rejects.toThrow("Couldn't read that directory.");
  });
});
