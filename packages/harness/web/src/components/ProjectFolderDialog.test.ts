import { describe, expect, it } from "vitest";

import { ApiError, type FsListResponse } from "../lib/api";
import { folderExists } from "./ProjectFolderDialog";

/**
 * The server answers a listing with its canonical spelling, so `folderExists`
 * must not read a canonical alias of the request as "missing". Only an
 * ancestor answer (the mock's nearest-ancestor resolution) means missing.
 */
const listing = (path: string): FsListResponse =>
  ({ path, parent: null, entries: [] }) as unknown as FsListResponse;

const answering =
  (answers: Record<string, string>, status = 404) =>
  async (path?: string): Promise<FsListResponse> => {
    const hit = path !== undefined ? answers[path] : undefined;
    if (hit === undefined) throw new ApiError(status, `GET /api/fs → ${status}`, undefined);
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

  it("treats a 404 target with a readable parent as missing, and neither as an error", async () => {
    await expect(
      folderExists("/Users/demo/missing", answering({ "/Users/demo": "/Users/demo" })),
    ).resolves.toBe(false);
    await expect(folderExists("/nope/deeper", answering({}))).rejects.toThrow(
      "Couldn't read that directory.",
    );
    await expect(folderExists("   ", answering({}))).resolves.toBe(false);
  });

  it("reports a forbidden or failed target as a read error, not a missing folder", async () => {
    // The parent lists fine; the target itself is 403. It exists, so saying
    // "doesn't exist yet" would be false and would hide the actual problem.
    await expect(
      folderExists("/srv/private", answering({ "/srv": "/srv" }, 403)),
    ).rejects.toThrow("Couldn't read that directory.");
    await expect(
      folderExists("/srv/private", answering({ "/srv": "/srv" }, 500)),
    ).rejects.toThrow("Couldn't read that directory.");
    await expect(
      folderExists("/srv/private", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("Couldn't read that directory.");
  });
});
