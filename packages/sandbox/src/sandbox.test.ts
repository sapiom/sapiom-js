import { SapiomSandbox } from "./sandbox";

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
 * Build a sandbox with a scripted fetch mock.
 * Each request to the create endpoint returns the create response; subsequent
 * calls are matched by `(method, url suffix)` against `handlers`.
 */
async function makeSandbox(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  createOverrides?: Partial<{ workspaceRoot: string }>,
): Promise<{ sandbox: SapiomSandbox; calls: FetchCall[] }> {
  const calls: FetchCall[] = [];
  let createCalled = false;
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
    if (!createCalled) {
      createCalled = true;
      return jsonResponse({
        name: "test-sb",
        source: "blaxel",
        status: "running",
        tier: "s",
        url: "https://sandbox-url",
        workspaceRoot: createOverrides?.workspaceRoot ?? "/blaxel/",
        expiresAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    for (const handler of handlers) {
      const response = await handler(call);
      if (response) return response;
    }
    throw new Error(
      `Unmatched mock fetch: ${init?.method ?? "GET"} ${url}`,
    );
  };

  const sandbox = await SapiomSandbox.create({
    name: "test-sb",
    fetch: fetchMock as typeof globalThis.fetch,
    baseUrl: "https://api.test",
  });

  // Drop the create call so assertions only see operation calls.
  calls.shift();

  return { sandbox, calls };
}

describe("SapiomSandbox — multipart methods", () => {
  describe("initiateMultipartUpload", () => {
    it("POSTs to the correct URL with permissions in the body", async () => {
      const { sandbox, calls } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST") {
            return jsonResponse({ uploadId: "u-1", path: "data/large.bin" });
          }
          return null;
        },
      ]);

      const result = await sandbox.initiateMultipartUpload("data/large.bin", {
        permissions: "0755",
      });

      expect(result).toEqual({ uploadId: "u-1", path: "data/large.bin" });
      expect(calls[0]!.url).toBe(
        "https://api.test/v1/sandboxes/test-sb/filesystem/multipart/initiate/data/large.bin",
      );
      expect(calls[0]!.init.method).toBe("POST");
      expect(calls[0]!.init.headers).toMatchObject({
        "Content-Type": "application/json",
      });
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
        permissions: "0755",
      });
    });

    it("omits permissions from the body when not provided", async () => {
      const { sandbox, calls } = await makeSandbox([
        () => jsonResponse({ uploadId: "u-1", path: "x" }),
      ]);
      await sandbox.initiateMultipartUpload("x");
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({});
    });

    it("encodes path segments", async () => {
      const { sandbox, calls } = await makeSandbox([
        () => jsonResponse({ uploadId: "u", path: "with space" }),
      ]);
      await sandbox.initiateMultipartUpload("dir with space/file.bin");
      expect(calls[0]!.url).toBe(
        "https://api.test/v1/sandboxes/test-sb/filesystem/multipart/initiate/dir%20with%20space/file.bin",
      );
    });

    it("rejects paths containing '..'", async () => {
      const { sandbox } = await makeSandbox([]);
      await expect(
        sandbox.initiateMultipartUpload("../escape"),
      ).rejects.toThrow(/must not contain '\.\.'/);
    });

    it("throws with a useful message on non-2xx", async () => {
      const { sandbox } = await makeSandbox([
        () => new Response("boom", { status: 500 }),
      ]);
      await expect(sandbox.initiateMultipartUpload("x")).rejects.toThrow(
        /Failed to initiate multipart upload for 'x': 500 boom/,
      );
    });
  });

  describe("uploadPart", () => {
    it("PUTs multipart/form-data with `file` field and partNumber query param", async () => {
      const { sandbox, calls } = await makeSandbox([
        () => jsonResponse({ partNumber: 3, etag: "etag-3", size: 100 }),
      ]);

      const ack = await sandbox.uploadPart(
        "u-42",
        3,
        new Uint8Array([1, 2, 3, 4, 5]),
      );
      expect(ack).toEqual({ partNumber: 3, etag: "etag-3", size: 100 });
      expect(calls[0]!.url).toBe(
        "https://api.test/v1/sandboxes/test-sb/filesystem/multipart/u-42/part?partNumber=3",
      );
      expect(calls[0]!.init.method).toBe("PUT");
      expect(calls[0]!.init.body).toBeInstanceOf(FormData);
      const form = calls[0]!.init.body as FormData;
      expect(form.get("file")).toBeInstanceOf(Blob);
      // Do not set Content-Type manually — fetch must set the boundary.
      expect((calls[0]!.init.headers as Record<string, string> | undefined)?.[
        "Content-Type"
      ]).toBeUndefined();
    });

    it("accepts a Blob directly without double-wrapping", async () => {
      const { sandbox, calls } = await makeSandbox([
        () => jsonResponse({ partNumber: 1, etag: "e", size: 3 }),
      ]);
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      await sandbox.uploadPart("u", 1, blob);
      // FormData promotes Blob entries to File per WHATWG spec, so identity
      // won't hold; assert the content instead.
      const form = calls[0]!.init.body as FormData;
      const entry = form.get("file") as Blob;
      expect(entry.size).toBe(3);
      const roundtrip = new Uint8Array(await entry.arrayBuffer());
      expect(Array.from(roundtrip)).toEqual([1, 2, 3]);
    });

    it("encodes uploadId in the URL", async () => {
      const { sandbox, calls } = await makeSandbox([
        () => jsonResponse({ partNumber: 1, etag: "e", size: 1 }),
      ]);
      await sandbox.uploadPart("id/with slash", 1, new Uint8Array([0]));
      expect(calls[0]!.url).toContain("/multipart/id%2Fwith%20slash/part");
    });
  });

  describe("completeMultipartUpload", () => {
    it("POSTs the parts array as JSON", async () => {
      const { sandbox, calls } = await makeSandbox([
        () =>
          jsonResponse({
            message: "Upload completed successfully",
            path: "big.bin",
          }),
      ]);

      const parts = [
        { partNumber: 1, etag: "e1" },
        { partNumber: 2, etag: "e2" },
      ];
      const result = await sandbox.completeMultipartUpload("u-1", parts);
      expect(result).toEqual({
        message: "Upload completed successfully",
        path: "big.bin",
      });
      expect(calls[0]!.url).toBe(
        "https://api.test/v1/sandboxes/test-sb/filesystem/multipart/u-1/complete",
      );
      expect(calls[0]!.init.method).toBe("POST");
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ parts });
    });
  });

  describe("abortMultipartUpload", () => {
    it("DELETEs the upload without an /abort suffix", async () => {
      const { sandbox, calls } = await makeSandbox([
        () => jsonResponse({ message: "aborted" }),
      ]);
      await sandbox.abortMultipartUpload("u-9");
      expect(calls[0]!.url).toBe(
        "https://api.test/v1/sandboxes/test-sb/filesystem/multipart/u-9",
      );
      expect(calls[0]!.init.method).toBe("DELETE");
    });
  });

  describe("listMultipartParts", () => {
    it("GETs and returns the parts array", async () => {
      const { sandbox, calls } = await makeSandbox([
        () =>
          jsonResponse({
            uploadId: "u-1",
            parts: [
              {
                partNumber: 1,
                etag: "e1",
                size: 1024,
                uploadedAt: "2026-01-01T00:00:00Z",
              },
            ],
          }),
      ]);
      const parts = await sandbox.listMultipartParts("u-1");
      expect(parts).toHaveLength(1);
      expect(parts[0]!.etag).toBe("e1");
      expect(calls[0]!.url).toBe(
        "https://api.test/v1/sandboxes/test-sb/filesystem/multipart/u-1/parts",
      );
    });
  });

  describe("uploadFile", () => {
    it("single-part upload for content smaller than partSize", async () => {
      const uploadedParts: number[] = [];
      const { sandbox, calls } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u-1", path: "small.bin" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            const qp = new URL(call.url).searchParams.get("partNumber")!;
            const partNumber = Number(qp);
            uploadedParts.push(partNumber);
            return jsonResponse({ partNumber, etag: `e${partNumber}`, size: 10 });
          }
          if (
            call.init.method === "POST" &&
            call.url.includes("/complete")
          ) {
            return jsonResponse({ message: "ok", path: "small.bin" });
          }
          return null;
        },
      ]);

      await sandbox.uploadFile("small.bin", new Uint8Array(10), {
        partSize: 1024,
      });

      expect(uploadedParts).toEqual([1]);
      // 1 initiate + 1 upload + 1 complete
      expect(calls).toHaveLength(3);
    });

    it("multi-part upload splits bytes correctly and sends parts sorted by partNumber on complete", async () => {
      let completeBody: { parts: Array<{ partNumber: number; etag: string }> } | null =
        null;
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u-1", path: "big.bin" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            const partNumber = Number(
              new URL(call.url).searchParams.get("partNumber")!,
            );
            const form = call.init.body as FormData;
            const file = form.get("file") as Blob;
            return jsonResponse({
              partNumber,
              etag: `e${partNumber}`,
              size: file.size,
            });
          }
          if (call.init.method === "POST" && call.url.includes("/complete")) {
            completeBody = JSON.parse(call.init.body as string);
            return jsonResponse({ message: "ok", path: "big.bin" });
          }
          return null;
        },
      ]);

      // 3 parts of size 1000, then one remainder of 500
      const bytes = new Uint8Array(3500);
      await sandbox.uploadFile("big.bin", bytes, { partSize: 1000, concurrency: 2 });

      expect(completeBody!.parts).toEqual([
        { partNumber: 1, etag: "e1" },
        { partNumber: 2, etag: "e2" },
        { partNumber: 3, etag: "e3" },
        { partNumber: 4, etag: "e4" },
      ]);
    });

    it("fires onPartUploaded with cumulative progress", async () => {
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u", path: "p" });
          }
          if (call.init.method === "PUT") {
            const n = Number(
              new URL(call.url).searchParams.get("partNumber")!,
            );
            return jsonResponse({ partNumber: n, etag: `e${n}`, size: 1000 });
          }
          return jsonResponse({ message: "ok", path: "p" });
        },
      ]);

      const events: Array<{ partsUploaded: number; bytesUploaded: number }> = [];
      await sandbox.uploadFile("p", new Uint8Array(3000), {
        partSize: 1000,
        concurrency: 1, // sequential for deterministic event ordering
        onPartUploaded: (_p, prog) => {
          events.push({
            partsUploaded: prog.partsUploaded,
            bytesUploaded: prog.bytesUploaded,
          });
        },
      });

      expect(events).toEqual([
        { partsUploaded: 1, bytesUploaded: 1000 },
        { partsUploaded: 2, bytesUploaded: 2000 },
        { partsUploaded: 3, bytesUploaded: 3000 },
      ]);
    });

    it("aborts the upload when a part fails and re-throws the original error", async () => {
      let abortCalled = false;
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u-abort", path: "p" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            const n = Number(
              new URL(call.url).searchParams.get("partNumber")!,
            );
            if (n === 2) {
              return new Response("part 2 broke", { status: 500 });
            }
            return jsonResponse({ partNumber: n, etag: `e${n}`, size: 1000 });
          }
          if (
            call.init.method === "DELETE" &&
            call.url.includes("/multipart/u-abort")
          ) {
            abortCalled = true;
            return jsonResponse({ message: "aborted" });
          }
          return null;
        },
      ]);

      await expect(
        sandbox.uploadFile("p", new Uint8Array(3000), {
          partSize: 1000,
          concurrency: 1,
        }),
      ).rejects.toThrow(/Failed to upload part 2/);

      // Let the fire-and-forget abort() settle
      await new Promise((r) => setImmediate(r));
      expect(abortCalled).toBe(true);
    });

    it("aborts the upload when opts.signal aborts mid-flight", async () => {
      let abortCalled = false;
      const controller = new AbortController();

      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u-sig", path: "p" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            // The init from uploadPart should carry the signal through
            const sig = call.init.signal as AbortSignal | undefined;
            if (sig?.aborted) {
              return Promise.reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            }
            // Fire the abort before responding to part 1
            controller.abort();
            return Promise.reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            );
          }
          if (
            call.init.method === "DELETE" &&
            call.url.includes("/multipart/u-sig")
          ) {
            abortCalled = true;
            return jsonResponse({ message: "aborted" });
          }
          return null;
        },
      ]);

      await expect(
        sandbox.uploadFile("p", new Uint8Array(3000), {
          partSize: 1000,
          concurrency: 1,
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      await new Promise((r) => setImmediate(r));
      expect(abortCalled).toBe(true);
    });

    it("rejects inputs that would exceed MAX_PARTS before making any HTTP call", async () => {
      const { sandbox, calls } = await makeSandbox([]);
      await expect(
        sandbox.uploadFile("p", new Uint8Array(10_001), { partSize: 1 }),
      ).rejects.toThrow(/Increase partSize to at least/);
      expect(calls).toHaveLength(0);
    });

    it("respects concurrency by limiting in-flight part uploads", async () => {
      let inFlight = 0;
      let peak = 0;
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u", path: "p" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            const n = Number(
              new URL(call.url).searchParams.get("partNumber")!,
            );
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            return new Promise<Response>((resolve) => {
              setTimeout(() => {
                inFlight -= 1;
                resolve(
                  jsonResponse({ partNumber: n, etag: `e${n}`, size: 1000 }),
                );
              }, 10);
            });
          }
          return jsonResponse({ message: "ok", path: "p" });
        },
      ]);

      await sandbox.uploadFile("p", new Uint8Array(8000), {
        partSize: 1000,
        concurrency: 3,
      });

      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThanOrEqual(2);
    });

    it("retries failed parts on retryable status codes", async () => {
      const attemptsByPart: Record<number, number> = {};
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u-retry", path: "p" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            const n = Number(
              new URL(call.url).searchParams.get("partNumber")!,
            );
            attemptsByPart[n] = (attemptsByPart[n] ?? 0) + 1;
            // Part 2 fails twice with 503 before succeeding
            if (n === 2 && attemptsByPart[n] < 3) {
              return new Response("upstream hiccup", { status: 503 });
            }
            return jsonResponse({ partNumber: n, etag: `e${n}`, size: 1000 });
          }
          if (call.init.method === "POST" && call.url.includes("/complete")) {
            return jsonResponse({ message: "ok", path: "p" });
          }
          return null;
        },
      ]);

      await sandbox.uploadFile("p", new Uint8Array(3000), {
        partSize: 1000,
        concurrency: 1,
        retryBaseDelayMs: 1,
      });

      expect(attemptsByPart).toEqual({ 1: 1, 2: 3, 3: 1 });
    });

    it("gives up and aborts after exhausting maxRetries", async () => {
      let attempts = 0;
      let abortCalled = false;
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u-x", path: "p" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            attempts += 1;
            return new Response("always broken", { status: 500 });
          }
          if (
            call.init.method === "DELETE" &&
            call.url.includes("/multipart/u-x")
          ) {
            abortCalled = true;
            return jsonResponse({ message: "aborted" });
          }
          return null;
        },
      ]);

      await expect(
        sandbox.uploadFile("p", new Uint8Array(1000), {
          partSize: 1000,
          maxRetries: 2,
          retryBaseDelayMs: 1,
        }),
      ).rejects.toThrow(/Failed to upload part 1/);

      // 1 initial + 2 retries = 3
      expect(attempts).toBe(3);
      await new Promise((r) => setImmediate(r));
      expect(abortCalled).toBe(true);
    });

    it("does not retry deterministic 4xx like 413", async () => {
      let attempts = 0;
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u-413", path: "p" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            attempts += 1;
            return new Response("too big", { status: 413 });
          }
          if (call.init.method === "DELETE") {
            return jsonResponse({ message: "aborted" });
          }
          return null;
        },
      ]);

      await expect(
        sandbox.uploadFile("p", new Uint8Array(1000), {
          partSize: 1000,
          retryBaseDelayMs: 1,
        }),
      ).rejects.toThrow(/413/);
      // No retry — 413 is not retryable
      expect(attempts).toBe(1);
    });

    it("works with a string input (UTF-8 encoded)", async () => {
      let totalBytes = 0;
      const { sandbox } = await makeSandbox([
        (call) => {
          if (call.init.method === "POST" && call.url.includes("/initiate/")) {
            return jsonResponse({ uploadId: "u", path: "s.txt" });
          }
          if (call.init.method === "PUT" && call.url.includes("/part")) {
            const n = Number(
              new URL(call.url).searchParams.get("partNumber")!,
            );
            const file = (call.init.body as FormData).get("file") as Blob;
            totalBytes += file.size;
            return jsonResponse({ partNumber: n, etag: `e${n}`, size: file.size });
          }
          return jsonResponse({ message: "ok", path: "s.txt" });
        },
      ]);

      await sandbox.uploadFile("s.txt", "héllo", { partSize: 1024 });
      // UTF-8 encoding of 'héllo' = 6 bytes
      expect(totalBytes).toBe(6);
    });
  });
});
