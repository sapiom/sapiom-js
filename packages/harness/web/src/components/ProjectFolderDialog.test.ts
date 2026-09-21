import { describe, expect, it } from "vitest";

import type { FsListResponse } from "../lib/api";
import { folderExists } from "./ProjectFolderDialog";

/**
 * The server answers a listing with its canonical spelling, so `folderExists`
 * must not read a canonical alias of the request as "missing". Only an
 * ancestor answer (the mock's nearest-ancestor resolution) means missing.
 */
const listing = (path: string): FsListResponse =>
  ({ path, parent: null, entries: [] }) as unknown as FsListResponse;

const answering =
  (answers: Record<string, string>) =>
  async (path?: string): Promise<FsListResponse> => {
    const hit = path !== undefined ? answers[path] : undefined;
    if (hit === undefined) throw new Error(`404 ${path}`);
    return listing(hit);
  };

describe("folderExists", () => {
  it("accepts the server's canonical spelling of the same folder", async () => {
    await expect(
      folderExists(
        "C:/Users/Alice/project",
        answering({ "C:/Users/Alice/project": "C:\\Users\\Alice\\project" }),
      ),
    ).resolves.toBe(true);
    await expect(
      folderExists("~/work/acme", answering({ "~/work/acme": "/Users/alice/work/acme" })),
    ).resolves.toBe(true);
    await expect(
      folderExists("/work/./x/../acme/", answering({ "/work/./x/../acme": "/work/acme" })),
    ).resolves.toBe(true);
    await expect(
      folderExists("c:/Work/Acme", answering({ "c:/Work/Acme": "C:\\work\\acme" })),
    ).resolves.toBe(true);
  });

  it("reads an ancestor answer as a missing folder", async () => {
    await expect(
      folderExists("/Users/demo/missing", answering({ "/Users/demo/missing": "/Users/demo" })),
    ).resolves.toBe(false);
    await expect(
      folderExists("/nope", answering({ "/nope": "/" })),
    ).resolves.toBe(false);
    await expect(
      folderExists("C:\\Users\\Alice\\missing", answering({ "C:\\Users\\Alice\\missing": "C:\\Users\\Alice" })),
    ).resolves.toBe(false);
  });

  it("treats an unreadable target with a readable parent as missing, and neither as an error", async () => {
    await expect(
      folderExists("/Users/demo/missing", answering({ "/Users/demo": "/Users/demo" })),
    ).resolves.toBe(false);
    await expect(folderExists("/nope/deeper", answering({}))).rejects.toThrow(
      "Couldn't read that directory.",
    );
    await expect(folderExists("   ", answering({}))).resolves.toBe(false);
  });
});
