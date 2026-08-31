/**
 * The browser host's only folder completion, and the one branch the e2e suite
 * cannot reach.
 *
 * `folder-field.spec.ts` runs against the mock filesystem, which resolves a
 * missing tail to its nearest existing ancestor rather than rejecting (see
 * `detect-folder.ts`'s header). So `listDir` never rejects there, and the
 * ancestor fallback — the thing that makes a HALF-TYPED path complete against a
 * real server, which 404s it — has no coverage from that side at all. Deleting
 * the fallback would keep every suite green and silently cost `npx` users their
 * completion mid-type.
 */
import { describe, expect, it, vi } from "vitest";

import type { FsListResponse } from "./api";
import { folderCompletions } from "./folder-completions";

const listing = (path: string, ...names: string[]): FsListResponse =>
  ({
    path,
    parent: path.slice(0, path.lastIndexOf("/")) || "/",
    dirs: names.map((name) => ({ name, path: `${path}/${name}`, hasAgentProject: false })),
  }) as FsListResponse;

const rejects = (): Promise<never> => Promise.reject(new Error("ENOENT"));

describe("folderCompletions", () => {
  it("offers the children of a folder that exists", async () => {
    const listDir = vi.fn(async () => listing("/Users/demo", "acme-app", "scratch"));
    expect(await folderCompletions("/Users/demo", listDir)).toEqual([
      "/Users/demo/acme-app",
      "/Users/demo/scratch",
    ]);
  });

  it("passes undefined for an empty field so the server picks the start folder", async () => {
    const listDir = vi.fn(async () => listing("/Users/demo", "acme-app"));
    await folderCompletions("", listDir);
    expect(listDir).toHaveBeenCalledWith(undefined);
  });

  it("falls back to the parent when the typed tail does not exist yet", async () => {
    /* THE BRANCH THE E2E SUITE CANNOT REACH. Typing `/Users/demo/acm` against a
       real server 404s, and the listing that can complete it is `/Users/demo`'s.
       Without this the datalist empties out the moment a user starts typing a
       folder name — exactly when completion is worth having. */
    const listDir = vi.fn(async (path?: string) =>
      path === "/Users/demo" ? listing("/Users/demo", "acme-app", "scratch") : rejects(),
    );
    expect(await folderCompletions("/Users/demo/acm", listDir)).toEqual([
      "/Users/demo/acme-app",
      "/Users/demo/scratch",
    ]);
    expect(listDir).toHaveBeenCalledWith("/Users/demo/acm");
    expect(listDir).toHaveBeenCalledWith("/Users/demo");
  });

  it("returns nothing — not a rejection — when neither the folder nor its parent reads", async () => {
    // A rejecting promise here would surface as an unhandled rejection in the
    // effect that calls this; the field must simply stop suggesting.
    const listDir = vi.fn(rejects);
    await expect(folderCompletions("/Users/demo/acm", listDir)).resolves.toEqual([]);
  });

  it("stops at the root rather than retrying itself forever", async () => {
    // `parentOf("/")` is null, so there is no second listing to try.
    const listDir = vi.fn(rejects);
    await expect(folderCompletions("/", listDir)).resolves.toEqual([]);
    expect(listDir).toHaveBeenCalledTimes(1);
  });
});
