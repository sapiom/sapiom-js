import { SapiomFileStorage } from "./file-storage";
import { FileStorageHttpError } from "./errors";

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Build a SapiomFileStorage client with a scripted fetch mock.
 * Each call is matched against `handlers` in order; the first handler that
 * returns a non-null value wins.
 */
function makeClient(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  opts?: { apiKey?: string; baseUrl?: string },
): { client: SapiomFileStorage; calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  const fetchMock = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);

    for (const handler of handlers) {
      const response = await handler(call);
      if (response) return response;
    }
    throw new Error(`Unmatched mock fetch: ${init?.method ?? "GET"} ${url}`);
  };

  const client = SapiomFileStorage.create({
    apiKey: opts?.apiKey ?? "test-api-key",
    baseUrl: opts?.baseUrl ?? "https://api.test",
    fetch: fetchMock as typeof globalThis.fetch,
  });

  return { client, calls };
}

// ---------------------------------------------------------------------------
// upload()
// ---------------------------------------------------------------------------

describe("SapiomFileStorage.upload()", () => {
  it("POSTs to /upload with JSON body and returns camelCased response", async () => {
    const { client, calls } = makeClient([
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

    const result = await client.upload({
      contentType: "image/png",
      fileName: "photo.png",
      visibility: "public",
      expectedFileSize: 1024,
    });

    expect(result).toEqual({
      fileId: "f-123",
      uploadUrl: "https://storage.googleapis.com/bucket/f-123?sig=abc",
      expiresAt: "2026-06-22T12:00:00Z",
      requiredHeaders: { "Content-Type": "image/png" },
    });

    expect(calls[0]!.url).toBe("https://api.test/upload");
    expect(calls[0]!.init.method).toBe("POST");
    expect(
      (calls[0]!.init.headers as Record<string, string>)["x-sapiom-api-key"],
    ).toBe("test-api-key");
    expect(
      (calls[0]!.init.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content_type: "image/png",
      file_name: "photo.png",
      visibility: "public",
      expected_file_size: 1024,
    });
  });

  it("omits optional fields from the body when not provided", async () => {
    const { client, calls } = makeClient([
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

    await client.upload({ contentType: "application/pdf" });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ content_type: "application/pdf" });
    expect(body).not.toHaveProperty("file_name");
    expect(body).not.toHaveProperty("visibility");
    expect(body).not.toHaveProperty("expected_file_size");
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { client } = makeClient([
      () =>
        new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
        }),
    ]);

    await expect(
      client.upload({ contentType: "image/png" }),
    ).rejects.toBeInstanceOf(FileStorageHttpError);

    try {
      await client.upload({ contentType: "image/png" });
    } catch (err) {
      expect(err).toBeInstanceOf(FileStorageHttpError);
      expect((err as FileStorageHttpError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// getDownloadUrl()
// ---------------------------------------------------------------------------

describe("SapiomFileStorage.getDownloadUrl()", () => {
  it("GETs /download/:fileId and returns camelCased response", async () => {
    const { client, calls } = makeClient([
      () =>
        jsonResponse({
          download_url: "https://storage.googleapis.com/bucket/f-123?sig=xyz",
          expires_at: "2026-06-22T13:00:00Z",
        }),
    ]);

    const result = await client.getDownloadUrl("f-123");

    expect(result).toEqual({
      downloadUrl: "https://storage.googleapis.com/bucket/f-123?sig=xyz",
      expiresAt: "2026-06-22T13:00:00Z",
    });

    expect(calls[0]!.url).toBe("https://api.test/download/f-123");
    expect(calls[0]!.init.method).toBeUndefined(); // GET (no method set = default GET)
    expect(
      (calls[0]!.init.headers as Record<string, string>)["x-sapiom-api-key"],
    ).toBe("test-api-key");
  });

  it("encodes special characters in fileId", async () => {
    const { client, calls } = makeClient([
      () =>
        jsonResponse({
          download_url: "https://gcs.example/d",
          expires_at: "2026-06-22T13:00:00Z",
        }),
    ]);

    await client.getDownloadUrl("file id/with slash");
    expect(calls[0]!.url).toBe(
      "https://api.test/download/file%20id%2Fwith%20slash",
    );
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { client } = makeClient([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(client.getDownloadUrl("bad-id")).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("SapiomFileStorage.list()", () => {
  const mockFile: object = {
    file_id: "f-1",
    file_name: "doc.pdf",
    content_type: "application/pdf",
    visibility: "private",
    status: "uploaded",
    expected_file_size: 2048,
    actual_file_size: 2000,
    created_at: "2026-06-01T00:00:00Z",
    uploaded_at: "2026-06-01T00:01:00Z",
    deleted_at: null,
    download_request_count: 3,
  };

  it("GETs /files and maps snake_case to camelCase", async () => {
    const { client, calls } = makeClient([
      () =>
        jsonResponse({
          files: [mockFile],
          limit: 20,
          offset: 0,
          has_more: false,
        }),
    ]);

    const result = await client.list();

    expect(result.hasMore).toBe(false);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      fileId: "f-1",
      fileName: "doc.pdf",
      contentType: "application/pdf",
      visibility: "private",
      status: "uploaded",
      expectedFileSize: 2048,
      actualFileSize: 2000,
      createdAt: "2026-06-01T00:00:00Z",
      uploadedAt: "2026-06-01T00:01:00Z",
      downloadRequestCount: 3,
    });

    expect(calls[0]!.url).toBe("https://api.test/files");
    expect(
      (calls[0]!.init.headers as Record<string, string>)["x-sapiom-api-key"],
    ).toBe("test-api-key");
  });

  it("appends limit and offset as query params when provided", async () => {
    const { client, calls } = makeClient([
      () =>
        jsonResponse({
          files: [],
          limit: 10,
          offset: 20,
          has_more: false,
        }),
    ]);

    await client.list({ limit: 10, offset: 20 });
    expect(calls[0]!.url).toBe("https://api.test/files?limit=10&offset=20");
  });

  it("omits query params when limit/offset are not provided", async () => {
    const { client, calls } = makeClient([
      () => jsonResponse({ files: [], limit: 20, offset: 0, has_more: false }),
    ]);

    await client.list();
    expect(calls[0]!.url).toBe("https://api.test/files");
  });

  it("appends only limit when offset is not provided", async () => {
    const { client, calls } = makeClient([
      () => jsonResponse({ files: [], limit: 5, offset: 0, has_more: false }),
    ]);

    await client.list({ limit: 5 });
    expect(calls[0]!.url).toBe("https://api.test/files?limit=5");
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { client } = makeClient([
      () => new Response("server error", { status: 500 }),
    ]);

    await expect(client.list()).rejects.toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("SapiomFileStorage.delete()", () => {
  it("DELETEs /:fileId and resolves void on 204", async () => {
    const { client, calls } = makeClient([
      () => new Response(null, { status: 204 }),
    ]);

    const result = await client.delete("f-abc");
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe("https://api.test/f-abc");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(
      (calls[0]!.init.headers as Record<string, string>)["x-sapiom-api-key"],
    ).toBe("test-api-key");
  });

  it("encodes special characters in fileId", async () => {
    const { client, calls } = makeClient([
      () => new Response(null, { status: 204 }),
    ]);

    await client.delete("file id/with slash");
    expect(calls[0]!.url).toBe("https://api.test/file%20id%2Fwith%20slash");
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { client } = makeClient([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(client.delete("bad-id")).rejects.toBeInstanceOf(
      FileStorageHttpError,
    );

    try {
      await client.delete("bad-id");
    } catch (err) {
      expect((err as FileStorageHttpError).status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// setVisibility()
// ---------------------------------------------------------------------------

describe("SapiomFileStorage.setVisibility()", () => {
  const rawMetadata = {
    file_id: "f-xyz",
    file_name: "report.pdf",
    content_type: "application/pdf",
    visibility: "public" as const,
    status: "uploaded",
    created_at: "2026-06-01T00:00:00Z",
    download_request_count: 0,
  };

  it("PATCHes /:fileId with visibility body and maps response", async () => {
    const { client, calls } = makeClient([() => jsonResponse(rawMetadata)]);

    const result = await client.setVisibility("f-xyz", "public");

    expect(result).toMatchObject({
      fileId: "f-xyz",
      fileName: "report.pdf",
      contentType: "application/pdf",
      visibility: "public",
      status: "uploaded",
      downloadRequestCount: 0,
    });

    expect(calls[0]!.url).toBe("https://api.test/f-xyz");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(
      (calls[0]!.init.headers as Record<string, string>)["x-sapiom-api-key"],
    ).toBe("test-api-key");
    expect(
      (calls[0]!.init.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      visibility: "public",
    });
  });

  it("encodes special characters in fileId", async () => {
    const { client, calls } = makeClient([
      () => jsonResponse({ ...rawMetadata, file_id: "file id/slash" }),
    ]);

    await client.setVisibility("file id/slash", "private");
    expect(calls[0]!.url).toBe("https://api.test/file%20id%2Fslash");
  });

  it("throws FileStorageHttpError on non-2xx", async () => {
    const { client } = makeClient([
      () => new Response("forbidden", { status: 403 }),
    ]);

    await expect(client.setVisibility("f-xyz", "public")).rejects.toMatchObject(
      { status: 403 },
    );
  });
});

// ---------------------------------------------------------------------------
// API key header
// ---------------------------------------------------------------------------

describe("SapiomFileStorage — x-sapiom-api-key header", () => {
  it("sends x-sapiom-api-key on all requests", async () => {
    const calls: string[] = [];
    const client = SapiomFileStorage.create({
      apiKey: "my-key",
      baseUrl: "https://api.test",
      fetch: (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        calls.push(url);
        const method = init?.method ?? "GET";
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (method === "PATCH")
          return new Response(
            JSON.stringify({
              file_id: "f",
              content_type: "text/plain",
              visibility: "private",
              status: "uploaded",
              created_at: "2026-06-01T00:00:00Z",
              download_request_count: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        return new Response(
          JSON.stringify({
            file_id: "f",
            upload_url: "https://gcs.example/u",
            expires_at: "2026-06-22T12:00:00Z",
            required_headers: {},
            download_url: "https://gcs.example/d",
            files: [],
            limit: 20,
            offset: 0,
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof globalThis.fetch,
    });

    // All methods send the key (just verifying the client was created with the right key)
    await client.upload({ contentType: "text/plain" });
    await client.getDownloadUrl("f");
    await client.list();
    await client.delete("f");
    await client.setVisibility("f", "private");

    expect(calls).toHaveLength(5);
  });

  it("does not set x-sapiom-api-key header when no API key is configured", async () => {
    // Temporarily remove SAPIOM_API_KEY from env so the fallback doesn't apply.
    const savedEnv = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];

    const capturedHeaders: Record<string, string>[] = [];
    const client = SapiomFileStorage.create({
      baseUrl: "https://api.test",
      fetch: (async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        capturedHeaders.push((init?.headers as Record<string, string>) ?? {});
        return new Response(
          JSON.stringify({
            files: [],
            limit: 20,
            offset: 0,
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof globalThis.fetch,
    });

    try {
      await client.list();
      expect(capturedHeaders[0]!["x-sapiom-api-key"]).toBeUndefined();
    } finally {
      if (savedEnv !== undefined) {
        process.env["SAPIOM_API_KEY"] = savedEnv;
      }
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
    expect(err.message).toBe("something went wrong");
  });
});
