import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import {
  images,
  createImage,
  createVideo,
  ContentGenerationHttpError,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers — the capability fn is tested directly with a real Transport wired to
// a scripted fetch mock, so URL/method/header/body assertions are exact and we
// verify the Transport injects the tenant credential.
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
// contentGeneration.images.create()
// ---------------------------------------------------------------------------

describe("contentGeneration.images.create()", () => {
  it("POSTs the default model with just the prompt + credential and maps the wire result to camelCase", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          images: [{ url: "https://media/x.png", content_type: "image/png" }],
          seed: 7,
        }),
    ]);

    const out = await createImage({ prompt: "a red bike" }, transport, BASE);

    // wire snake (content_type) → camelCase surface (contentType); top-level extras pass through.
    expect(out).toEqual({
      images: [{ url: "https://media/x.png", contentType: "image/png" }],
      seed: 7,
    });
    // model defaults internally — the caller named no provider.
    expect(calls[0]!.url).toBe(`${BASE}/run/fal-ai/flux/schnell`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a red bike",
    });
  });

  it("maps numImages → num_images, forwards `params` verbatim, honors an explicit model (slashes preserved)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await createImage(
      {
        prompt: "x",
        numImages: 3,
        params: { image_size: "square", seed: 42 },
        model: "/some/other/model/",
      },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/run/some/other/model`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      image_size: "square",
      seed: 42,
      num_images: 3,
    });
  });

  it("merges the optional `storage` param; the mapped image carries fileId", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [{ url: "u", file_id: "f1" }] }),
    ]);

    const out = await createImage(
      { prompt: "x", storage: { visibility: "public" } },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      storage: { visibility: "public" },
    });
    expect(out.images?.[0]?.fileId).toBe("f1");
  });

  it("omits `storage` when not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await createImage({ prompt: "x" }, transport, BASE);

    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty(
      "storage",
    );
  });

  it("treats a null `storage` (JS caller bypassing types) as absent", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await createImage(
      { prompt: "x", storage: null as unknown as undefined },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty(
      "storage",
    );
  });

  it("maps each image's fileId / storageError on a multi-image response", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          images: [
            { url: "a", file_id: "f-a" },
            { url: "b", file_id: "f-b" },
            { url: "c", storage_error: "exceeded max upload size" },
          ],
        }),
    ]);

    const out = await createImage(
      { prompt: "x", numImages: 3, storage: {} },
      transport,
      BASE,
    );

    expect(out.images?.map((i) => i.fileId)).toEqual(["f-a", "f-b", undefined]);
    expect(out.images?.[2]?.storageError).toBe("exceeded max upload size");
  });

  it("throws ContentGenerationHttpError (with status + body) on a non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({ message: "bad request", error: "Bad Request" }),
          { status: 400 },
        ),
    ]);

    await expect(
      createImage({ prompt: "x" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "ContentGenerationHttpError",
      status: 400,
      body: { error: "Bad Request" },
    });
    await expect(
      createImage({ prompt: "x" }, transport, BASE),
    ).rejects.toBeInstanceOf(ContentGenerationHttpError);
  });

  it("`images.create` is the same operation as `createImage`", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [{ url: "u" }] }),
    ]);

    await images.create({ prompt: "x" }, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/run/fal-ai/flux/schnell`);
  });
});

// ---------------------------------------------------------------------------
// createClient().contentGeneration.images — binding
// ---------------------------------------------------------------------------

describe("createClient().contentGeneration.images.create", () => {
  it("binds to the client's credential + default generation host, merging storage, mapping the result", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      return jsonResponse({ images: [{ url: "u", file_id: "f" }] });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
    const out = await sapiom.contentGeneration.images.create({
      prompt: "x",
      storage: { visibility: "private" },
    });

    expect(out.images?.[0]?.fileId).toBe("f");
    expect(calls[0]!.url).toBe(
      "https://fal.services.sapiom.ai/run/fal-ai/flux/schnell",
    );
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("client-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      storage: { visibility: "private" },
    });
  });
});

// ---------------------------------------------------------------------------
// contentGeneration.video.create()  — async: submit, then poll until ready
// ---------------------------------------------------------------------------

describe("contentGeneration.video.create()", () => {
  it("submits the default video model, polls until ready, and maps the result to camelCase", async () => {
    let polls = 0;
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              request_id: "req-1",
              response_url: `${BASE}/queue/fal-ai/veo3/requests/req-1`,
              status_url: `${BASE}/queue/fal-ai/veo3/requests/req-1/status`,
            })
          : null,
      (c) => {
        if (c.init.method !== "GET") return null;
        polls += 1;
        // pending first, completed result second
        return polls < 2
          ? jsonResponse({ status: "IN_PROGRESS" })
          : jsonResponse({
              video: { url: "https://media/v.mp4", content_type: "video/mp4" },
              seed: 9,
            });
      },
    ]);

    const out = await createVideo(
      { prompt: "a wave", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    // wire snake (content_type) → camelCase (contentType); top-level extras pass through.
    expect(out).toEqual({
      video: { url: "https://media/v.mp4", contentType: "video/mp4" },
      seed: 9,
    });
    // submit: default model, prompt only (no provider named, no storage).
    expect(calls[0]!.url).toBe(`${BASE}/run/fal-ai/veo3/fast`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ prompt: "a wave" });
    // polled the rewritten result URL until it carried output.
    expect(
      calls.filter(
        (c) =>
          c.init.method === "GET" &&
          c.url === `${BASE}/queue/fal-ai/veo3/requests/req-1`,
      ),
    ).toHaveLength(2);
  });

  it("sends storage on submit and surfaces fileId on the polled result", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              request_id: "req-2",
              response_url: `${BASE}/queue/req-2`,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({
              video: {
                url: "https://media/v2.mp4",
                content_type: "video/mp4",
                file_id: "vid-file-1",
              },
            })
          : null,
    ]);

    const out = await createVideo(
      { prompt: "x", storage: { visibility: "private" }, pollIntervalMs: 1 },
      transport,
      BASE,
    );

    expect(out.video).toEqual({
      url: "https://media/v2.mp4",
      contentType: "video/mp4",
      fileId: "vid-file-1",
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      storage: { visibility: "private" },
    });
  });

  it("maps a per-output storage_error to camelCase", async () => {
    const { transport } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({ request_id: "req-4", response_url: `${BASE}/queue/req-4` })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({
              video: { url: "https://media/v4.mp4", storage_error: "nope" },
            })
          : null,
    ]);

    const out = await createVideo(
      { prompt: "x", storage: {}, pollIntervalMs: 1 },
      transport,
      BASE,
    );

    expect(out.video).toEqual({
      url: "https://media/v4.mp4",
      storageError: "nope",
    });
  });

  it("throws ContentGenerationHttpError when the submit fails — never polls", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ error: "bad model" }, { status: 422 }),
    ]);

    await expect(
      createVideo({ prompt: "x", pollIntervalMs: 1 }, transport, BASE),
    ).rejects.toBeInstanceOf(ContentGenerationHttpError);
    expect(calls).toHaveLength(1); // submit only
  });

  it("throws if the result isn't ready before the timeout", async () => {
    const { transport } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({ request_id: "req-3", response_url: `${BASE}/queue/req-3` })
          : null,
      (c) =>
        c.init.method === "GET" ? jsonResponse({ status: "IN_PROGRESS" }) : null,
    ]);

    await expect(
      createVideo(
        { prompt: "x", pollIntervalMs: 1, timeoutMs: 20 },
        transport,
        BASE,
      ),
    ).rejects.toThrow(/did not complete within/);
  });
});

// ---------------------------------------------------------------------------
// createClient().contentGeneration.video — binding
// ---------------------------------------------------------------------------

describe("createClient().contentGeneration.video.create", () => {
  it("binds to the client credential + default host, submits then polls to the result", async () => {
    let polls = 0;
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      if (init.method === "POST") {
        return jsonResponse({
          request_id: "r",
          response_url: "https://fal.services.sapiom.ai/queue/r",
        });
      }
      polls += 1;
      return polls < 2
        ? jsonResponse({ status: "IN_PROGRESS" })
        : jsonResponse({ video: { url: "u", file_id: "f" } });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
    const out = await sapiom.contentGeneration.video.create({
      prompt: "x",
      storage: { visibility: "private" },
      pollIntervalMs: 1,
    });

    expect(out.video?.fileId).toBe("f");
    expect(calls[0]!.url).toBe(
      "https://fal.services.sapiom.ai/run/fal-ai/veo3/fast",
    );
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("client-key");
  });
});
