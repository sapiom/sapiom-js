import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sapiom } from "@sapiom/tools";
import { downloadFileBytes, listFilesByPrefix, uploadPublicFile } from "./storage.js";

afterEach(() => vi.unstubAllGlobals());

function fakeSapiom(fileStorage: Record<string, unknown>): Sapiom {
  return { fileStorage } as unknown as Sapiom;
}

describe("uploadPublicFile", () => {
  it("initiates a public upload and PUTs the bytes", async () => {
    const upload = vi.fn().mockResolvedValue({
      fileId: "f1",
      uploadUrl: "https://signed.example/put",
      expiresAt: "2099-01-01T00:00:00Z",
      requiredHeaders: { "content-type": "text/html" },
    });
    const put = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", put);
    const id = await uploadPublicFile(fakeSapiom({ upload }), {
      fileName: "news-roundup/polsia/pages/2026-07-22.html",
      contentType: "text/html",
      bytes: new TextEncoder().encode("<p>hi</p>"),
    });
    expect(id).toBe("f1");
    expect(upload).toHaveBeenCalledWith({
      contentType: "text/html",
      fileName: "news-roundup/polsia/pages/2026-07-22.html",
      visibility: "public",
      fileSize: 9,
    });
    expect(put).toHaveBeenCalledWith("https://signed.example/put", expect.objectContaining({ method: "PUT" }));
  });
  it("throws when the PUT fails", async () => {
    const upload = vi.fn().mockResolvedValue({
      fileId: "f1", uploadUrl: "https://signed.example/put", expiresAt: "x", requiredHeaders: {},
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(
      uploadPublicFile(fakeSapiom({ upload }), { fileName: "a", contentType: "t", bytes: new Uint8Array(1) }),
    ).rejects.toThrow(/500/);
  });
});

describe("listFilesByPrefix", () => {
  const file = (fileId: string, fileName: string, createdAt: string, status = "uploaded") => ({
    fileId, fileName, createdAt, status, contentType: "x", visibility: "public", fileSize: "1", downloadRequestCount: 0,
  });
  it("paginates, filters by prefix, drops deleted, dedupes keeping newest", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        files: [
          file("a", "news-roundup/polsia/pages/2026-07-22.html", "2026-07-22T01:00:00Z"),
          file("b", "other/x.html", "2026-07-22T01:00:00Z"),
        ],
        limit: 100, offset: 0, hasMore: true,
      })
      .mockResolvedValueOnce({
        files: [
          file("c", "news-roundup/polsia/pages/2026-07-22.html", "2026-07-22T02:00:00Z"),
          file("d", "news-roundup/polsia/images/2026-07-22-1.png", "2026-07-22T01:00:00Z"),
          file("e", "news-roundup/polsia/pages/old.html", "2026-01-01T00:00:00Z", "deleted"),
        ],
        limit: 100, offset: 100, hasMore: false,
      });
    const out = await listFilesByPrefix(fakeSapiom({ list }), "news-roundup/polsia/");
    expect(list).toHaveBeenCalledTimes(2);
    expect(out).toEqual(
      expect.arrayContaining([
        { fileId: "c", fileName: "news-roundup/polsia/pages/2026-07-22.html" },
        { fileId: "d", fileName: "news-roundup/polsia/images/2026-07-22-1.png" },
      ]),
    );
    expect(out).toHaveLength(2);
  });
});

describe("downloadFileBytes", () => {
  it("resolves a fresh URL and GETs the bytes", async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue({ downloadUrl: "https://signed.example/get", expiresAt: "x" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    const bytes = await downloadFileBytes(fakeSapiom({ getDownloadUrl }), "f1");
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});
