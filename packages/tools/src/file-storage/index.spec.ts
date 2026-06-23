import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as fileStorage from "./index.js";
import { FileStorageHttpError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers — capability fns are tested directly with a real Transport wired to a
// scripted fetch mock (so URL/method/header/body assertions are exact, and we
// verify the Transport itself injects the tenant credential).
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeTransport(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  apiKey: string | undefined = "test-key",
): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = await handler({ url, init });
      if (response) return response;
    }
    throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
  }) as typeof globalThis.fetch;
  return { transport: new Transport({ apiKey, fetch: fetchMock }), calls };
}

const BASE = "https://api.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

// ---------------------------------------------------------------------------
// upload()
// ---------------------------------------------------------------------------

describe("fileStorage.upload()", () => {
  it("POSTs /upload with JSON body + credential and returns camelCase", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            file_id: "f-123",
            upload_url: "https://storage.googleapis.com/bucket/f-123?sig=abc",
            expires_at: "2026-06-22T12:00:00Z",
            required_headers: { "Content-Type": "image/png" },
          },
          { status: 201 },
        ),
    ]);

    const result = await fileStorage.upload(
      {
        contentType: "image/png",
        fileName: "photo.png",
        visibility: "public",
        expectedFileSize: 1024,
      },
      transport,
      BASE,
    );

    expect(result).toEqual({
      fileId: "f-123",
      uploadUrl: "https://storage.googleapis.com/bucket/f-123?sig=abc",
      expiresAt: "2026-06-22T12:00:00Z",
      requiredHeaders: { "Content-Type": "image/png" },
    });

    expect(calls[0]!.url).toBe(`${BASE}/upload`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content_type: "image/png",
      file_name: "photo.png",
      visibility: "public",
      expected_file_size: 1024,
    });
  });

  it("omits optional fields from the body when not provided", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            file_id: "f-1",
            upload_url: "https://gcs.example/u",
            expires_at: "2026-06-22T12:00:00Z",
            required_headers: {},
          },
          { status: 201 },
        ),
    ]);

    await fileStorage.upload(
      { contentType: "application/pdf" },
      transport,
      BASE,
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ content_type: "application/pdf" });
    expect(body).not.toHaveProperty("file_name");
    expect(body).not.toHaveProperty("visibility");
    expect(body).not.toHaveProperty("expected_file_size");
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
        }),
    ]);

    await expect(
      fileStorage.upload({ contentType: "image/png" }, transport, BASE),
    ).rejects.toBeInstanceOf(FileStorageHttpError);
  });
});

// ---------------------------------------------------------------------------
// getDownloadUrl()
// ---------------------------------------------------------------------------

describe("fileStorage.getDownloadUrl()", () => {
  it("GETs /download/:fileId and returns camelCase", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          download_url: "https://storage.googleapis.com/bucket/f-123?sig=xyz",
          expires_at: "2026-06-22T13:00:00Z",
        }),
    ]);

    const result = await fileStorage.getDownloadUrl("f-123", transport, BASE);

    expect(result).toEqual({
      downloadUrl: "https://storage.googleapis.com/bucket/f-123?sig=xyz",
      expiresAt: "2026-06-22T13:00:00Z",
    });
    expect(calls[0]!.url).toBe(`${BASE}/download/f-123`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("encodes special characters in fileId", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          download_url: "https://gcs.example/d",
          expires_at: "2026-06-22T13:00:00Z",
        }),
    ]);

    await fileStorage.getDownloadUrl("file id/with slash", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/download/file%20id%2Fwith%20slash`);
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(
      fileStorage.getDownloadUrl("bad-id", transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("fileStorage.list()", () => {
  const mockFile = {
    file_id: "f-1",
    file_name: "doc.pdf",
    content_type: "application/pdf",
    visibility: "private",
    status: "uploaded",
    // gateway serializes int64 sizes as strings (verified live: e.g. "37")
    expected_file_size: "2048",
    actual_file_size: "2000",
    created_at: "2026-06-01T00:00:00Z",
    uploaded_at: "2026-06-01T00:01:00Z",
    deleted_at: null,
    download_request_count: 3,
  };

  it("GETs /files and maps snake_case to camelCase (sizes stay strings)", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          files: [mockFile],
          limit: 20,
          offset: 0,
          has_more: false,
        }),
    ]);

    const result = await fileStorage.list(undefined, transport, BASE);

    expect(result.hasMore).toBe(false);
    expect(result.limit).toBe(20);
    expect(result.files[0]).toMatchObject({
      fileId: "f-1",
      fileName: "doc.pdf",
      contentType: "application/pdf",
      visibility: "private",
      status: "uploaded",
      expectedFileSize: "2048",
      actualFileSize: "2000",
      downloadRequestCount: 3,
    });
    expect(calls[0]!.url).toBe(`${BASE}/files`);
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("appends limit and offset as query params when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ files: [], limit: 10, offset: 20, has_more: false }),
    ]);

    await fileStorage.list({ limit: 10, offset: 20 }, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/files?limit=10&offset=20`);
  });

  it("omits query params when limit/offset are not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ files: [], limit: 20, offset: 0, has_more: false }),
    ]);

    await fileStorage.list(undefined, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/files`);
  });

  it("appends only limit when offset is not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ files: [], limit: 5, offset: 0, has_more: false }),
    ]);

    await fileStorage.list({ limit: 5 }, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/files?limit=5`);
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("server error", { status: 500 }),
    ]);

    await expect(
      fileStorage.list(undefined, transport, BASE),
    ).rejects.toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("fileStorage.delete()", () => {
  it("DELETEs /:fileId and resolves void on 204", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    const result = await fileStorage.delete("f-abc", transport, BASE);
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/f-abc`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("encodes special characters in fileId", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await fileStorage.delete("file id/with slash", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/file%20id%2Fwith%20slash`);
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(
      fileStorage.delete("bad-id", transport, BASE),
    ).rejects.toBeInstanceOf(FileStorageHttpError);
  });
});

// ---------------------------------------------------------------------------
// setVisibility()
// ---------------------------------------------------------------------------

describe("fileStorage.setVisibility()", () => {
  const rawMetadata = {
    file_id: "f-xyz",
    file_name: "report.pdf",
    content_type: "application/pdf",
    visibility: "public",
    status: "uploaded",
    created_at: "2026-06-01T00:00:00Z",
    download_request_count: 0,
  };

  it("PATCHes /:fileId with visibility body and maps response", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(rawMetadata),
    ]);

    const result = await fileStorage.setVisibility(
      "f-xyz",
      "public",
      transport,
      BASE,
    );

    expect(result).toMatchObject({
      fileId: "f-xyz",
      visibility: "public",
      status: "uploaded",
    });
    expect(calls[0]!.url).toBe(`${BASE}/f-xyz`);
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      visibility: "public",
    });
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("forbidden", { status: 403 }),
    ]);

    await expect(
      fileStorage.setVisibility("f-xyz", "public", transport, BASE),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// ---------------------------------------------------------------------------
// Client wiring + auth
// ---------------------------------------------------------------------------

describe("fileStorage — client wiring + credential", () => {
  it("createClient().fileStorage routes all five methods with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "PATCH")
        return jsonResponse({
          file_id: "f",
          content_type: "text/plain",
          visibility: "private",
          status: "uploaded",
          created_at: "2026-06-01T00:00:00Z",
          download_request_count: 0,
        });
      return jsonResponse({
        file_id: "f",
        upload_url: "https://gcs.example/u",
        expires_at: "2026-06-22T12:00:00Z",
        required_headers: {},
        download_url: "https://gcs.example/d",
        files: [],
        limit: 20,
        offset: 0,
        has_more: false,
      });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.fileStorage.upload({ contentType: "text/plain" });
    await sapiom.fileStorage.getDownloadUrl("f");
    await sapiom.fileStorage.list();
    await sapiom.fileStorage.delete("f");
    await sapiom.fileStorage.setVisibility("f", "private");

    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
  });

  it("throws a clear error when no tenant credential is configured", async () => {
    const saved = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];
    try {
      const transport = new Transport({
        fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
      });
      await expect(
        fileStorage.list(undefined, transport, BASE),
      ).rejects.toThrow(/no tenant credential/i);
    } finally {
      if (saved !== undefined) process.env["SAPIOM_API_KEY"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// FileStorageHttpError
// ---------------------------------------------------------------------------

describe("FileStorageHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new FileStorageHttpError("something went wrong", 422, {
      message: "invalid",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FileStorageHttpError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ message: "invalid" });
    expect(err.name).toBe("FileStorageHttpError");
  });
});
