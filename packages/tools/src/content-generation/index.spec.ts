import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import {
  images,
  video,
  createImage,
  launchImage,
  createVideo,
  launchVideo,
  toVideoResumePayload,
  toImageResumePayload,
  VIDEO_RESULT_SIGNAL,
  IMAGE_RESULT_SIGNAL,
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
  it("POSTs to /v1/capabilities/content.generation.images with x-api-key and the prompt", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          images: [{ url: "https://media/x.png", contentType: "image/png" }],
        }),
    ]);

    const out = await createImage({ prompt: "a red bike" }, transport, BASE);

    // The router returns the normalized camelCase DTO (servedBy stripped at the boundary).
    expect(out).toEqual({
      images: [{ url: "https://media/x.png", contentType: "image/png" }],
    });
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/capabilities/content.generation.images`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    // Routed verbs authenticate via x-api-key (the /v1 guard's header), NOT the
    // gateway-direct x-sapiom-api-key — wrong header = silent 401.
    expect(headerOf(calls[0]!, "x-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // model omitted → the router's adapter defaults it; no /run/<model> URL building here.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a red bike",
    });
  });

  it("forwards numImages (camelCase), `params` as a nested field, and an explicit model verbatim", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await createImage(
      {
        prompt: "x",
        numImages: 3,
        params: { image_size: "square", seed: 42 },
        model: "fal-ai/flux/dev",
      },
      transport,
      BASE,
    );

    // model rides in the body (the adapter turns it into the provider path), and
    // params is nested — not spread — so the adapter forwards it verbatim.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      numImages: 3,
      params: { image_size: "square", seed: 42 },
      model: "fal-ai/flux/dev",
    });
  });

  it("merges the optional `storage` param; the mapped image carries fileId + downloadUrl", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          images: [
            {
              url: "u",
              fileId: "f1",
              downloadUrl: "https://dl/f1",
              downloadUrlExpiresAt: "2026-03-03T00:00:00Z",
            },
          ],
        }),
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
    // Core already normalized download_url/_expires_at → downloadUrl/downloadUrlExpiresAt; SDK passes them through.
    expect(out.images?.[0]?.downloadUrl).toBe("https://dl/f1");
    expect(out.images?.[0]?.downloadUrlExpiresAt).toBe("2026-03-03T00:00:00Z");
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
            { url: "a", fileId: "f-a" },
            { url: "b", fileId: "f-b" },
            { url: "c", storageError: "exceeded max upload size" },
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
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/capabilities/content.generation.images`,
    );
  });
});

// ---------------------------------------------------------------------------
// createClient().contentGeneration.images — binding
// ---------------------------------------------------------------------------

describe("createClient().contentGeneration.images.create", () => {
  it("binds to the client's credential + the Core base URL, sending x-api-key, mapping the result", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      return jsonResponse({ images: [{ url: "u", fileId: "f" }] });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
    const out = await sapiom.contentGeneration.images.create({
      prompt: "x",
      storage: { visibility: "private" },
    });

    expect(out.images?.[0]?.fileId).toBe("f");
    expect(calls[0]!.url).toBe(
      "https://api.sapiom.ai/v1/capabilities/content.generation.images",
    );
    expect(headerOf(calls[0]!, "x-api-key")).toBe("client-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      storage: { visibility: "private" },
    });
  });
});

// ---------------------------------------------------------------------------
// contentGeneration.video.create()  — routed submit, then poll until ready
// ---------------------------------------------------------------------------

describe("contentGeneration.video.create()", () => {
  it("POSTs to /v1/capabilities/content.generation.video with x-api-key and the prompt (model omitted → router default)", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-merge",
              statusUrl: `${BASE}/queue/req-merge/status`,
              responseUrl: `${BASE}/queue/req-merge`,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({
              video: {
                url: "https://media/merged.mp4",
                content_type: "video/mp4",
              },
            })
          : null,
    ]);

    const out = await createVideo(
      { prompt: "merge", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    // The submit always returns a queue handle (the video adapter's
    // `fromGatewayResponse` throws without one) — the poll target still returns
    // fal's raw snake_case result, mapped to camelCase here.
    expect(out).toEqual({
      video: {
        url: "https://media/merged.mp4",
        contentType: "video/mp4",
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/capabilities/content.generation.video`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    // Routed verbs authenticate via x-api-key (the /v1 guard's header), NOT the
    // gateway-direct x-sapiom-api-key — wrong header = silent 401.
    expect(headerOf(calls[0]!, "x-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    // model omitted → the router's video adapter defaults it; no /run/<model> URL building here.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "merge",
    });
  });

  it("sends a semantic alias verbatim in the body — no /run/<model> URL, no raw provider id in caller code", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-alias",
              responseUrl: `${BASE}/queue/req-alias`,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ video: { url: "https://media/v.mp4" } })
          : null,
    ]);

    await createVideo(
      { prompt: "a wave", model: "veo3-fast", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(
      `${BASE}/v1/capabilities/content.generation.video`,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a wave",
      model: "veo3-fast",
    });
    // The alias never gets turned into a URL path — the adapter resolves it server-side.
    expect(calls.some((c) => c.url.includes("/run/"))).toBe(false);
  });

  it("forwards `params` as a nested field, an explicit model verbatim, and `storage`", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-body-shape",
              responseUrl: `${BASE}/queue/req-body-shape`,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ video: { url: "https://media/v.mp4" } })
          : null,
    ]);

    await createVideo(
      {
        prompt: "x",
        model: "veo3-fast",
        params: { duration: 8, seed: 42 },
        storage: { visibility: "private" },
        pollIntervalMs: 1,
      },
      transport,
      BASE,
    );

    // model rides as a top-level body field (the caller's semantic alias, not a raw
    // provider id — the adapter resolves it server-side), and params is nested — not
    // spread to the top level — so the adapter forwards it verbatim. Mirrors
    // createImage's identically-named body-shape test.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      model: "veo3-fast",
      params: { duration: 8, seed: 42 },
      storage: { visibility: "private" },
    });
  });

  it("derives the result URL when the router returns only statusUrl", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-status-only",
              statusUrl: `${BASE}/queue/fal-ai/ffmpeg-api/requests/req-status-only/status`,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ video: { url: "https://media/merged.mp4" } })
          : null,
    ]);

    const out = await createVideo(
      { prompt: "merge", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    expect(out.video?.url).toBe("https://media/merged.mp4");
    expect(calls[1]!.url).toBe(
      `${BASE}/queue/fal-ai/ffmpeg-api/requests/req-status-only`,
    );
  });

  it("polls until ready and maps the raw snake poll result to camelCase", async () => {
    let polls = 0;
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-1",
              responseUrl: `${BASE}/queue/fal-ai/veo3/requests/req-1`,
              statusUrl: `${BASE}/queue/fal-ai/veo3/requests/req-1/status`,
            })
          : null,
      (c) => {
        if (c.init.method !== "GET") return null;
        polls += 1;
        // pending first, completed result second — the poll target still returns
        // fal's RAW snake_case result (the gateway's queue passthrough).
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
    // polled the rewritten result URL until it carried output.
    expect(
      calls.filter(
        (c) =>
          c.init.method === "GET" &&
          c.url === `${BASE}/queue/fal-ai/veo3/requests/req-1`,
      ),
    ).toHaveLength(2);
  });

  it("sends storage on submit and surfaces fileId + downloadUrl on the polled result", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-2",
              responseUrl: `${BASE}/queue/req-2`,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({
              video: {
                url: "https://media/v2.mp4",
                content_type: "video/mp4",
                file_id: "vid-file-1",
                download_url: "https://dl/vid-1",
                download_url_expires_at: "2026-03-03T00:00:00Z",
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
      downloadUrl: "https://dl/vid-1",
      downloadUrlExpiresAt: "2026-03-03T00:00:00Z",
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
          ? jsonResponse({
              requestId: "req-4",
              responseUrl: `${BASE}/queue/req-4`,
            })
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
          ? jsonResponse({
              requestId: "req-3",
              responseUrl: `${BASE}/queue/req-3`,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ status: "IN_PROGRESS" })
          : null,
    ]);

    await expect(
      createVideo(
        { prompt: "x", pollIntervalMs: 1, timeoutMs: 20 },
        transport,
        BASE,
      ),
    ).rejects.toThrow(/did not complete within/);
  });

  it("tolerates a transient non-ok poll, then returns once the result is ready", async () => {
    let polls = 0;
    const { transport } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-5",
              responseUrl: `${BASE}/queue/req-5`,
            })
          : null,
      (c) => {
        if (c.init.method !== "GET") return null;
        polls += 1;
        return polls < 2
          ? jsonResponse({ error: "upstream hiccup" }, { status: 503 })
          : jsonResponse({ video: { url: "https://media/v5.mp4" } });
      },
    ]);

    const out = await createVideo(
      { prompt: "x", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    expect(out.video?.url).toBe("https://media/v5.mp4");
  });

  it("`video.create` is the same operation as `createVideo`", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-ns2",
              responseUrl: `${BASE}/queue/req-ns2`,
            })
          : null,
      (c) =>
        c.init.method === "GET" ? jsonResponse({ video: { url: "u" } }) : null,
    ]);

    await video.create({ prompt: "x", pollIntervalMs: 1 }, transport, BASE);
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/capabilities/content.generation.video`,
    );
  });
});

// ---------------------------------------------------------------------------
// createClient().contentGeneration.video — binding
// ---------------------------------------------------------------------------

describe("createClient().contentGeneration.video.create", () => {
  it("binds to the client credential + the Core base URL, sending x-api-key, submits then polls to the result", async () => {
    let polls = 0;
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      if (init.method === "POST") {
        return jsonResponse({
          requestId: "r",
          responseUrl: "https://api.sapiom.ai/queue/r",
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
      "https://api.sapiom.ai/v1/capabilities/content.generation.video",
    );
    expect(headerOf(calls[0]!, "x-api-key")).toBe("client-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// contentGeneration.video.launch() — routed async dispatch + resume token
// ---------------------------------------------------------------------------

function makeLaunchTransport(
  submitResponse: unknown,
  pollResponse: unknown,
  resumeToken?: string,
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
    if (init.method === "POST") return jsonResponse(submitResponse);
    return jsonResponse(pollResponse);
  }) as typeof globalThis.fetch;
  return {
    transport: new Transport({
      apiKey: "test-key",
      fetch: fetchMock,
      resumeToken,
    }),
    calls,
  };
}

describe("contentGeneration.video.launch()", () => {
  it("accepts a statusUrl-only submit handle, deriving the poll URL by stripping /status", async () => {
    const { transport } = makeLaunchTransport(
      {
        requestId: "req-status-only",
        statusUrl: `${BASE}/queue/fal-ai/ffmpeg-api/requests/req-status-only/status`,
      },
      { video: { url: "https://media/merged.mp4" } },
    );

    const handle = await launchVideo({ prompt: "merge" }, transport, BASE);

    expect(handle.requestId).toBe("req-status-only");
    await expect(handle.wait({ pollMs: 1 })).resolves.toMatchObject({
      video: { url: "https://media/merged.mp4" },
    });
  });

  it("POSTs the routed capability with x-api-key, model as a body field, and returns a handle", async () => {
    const { transport, calls } = makeLaunchTransport(
      {
        requestId: "req-launch-1",
        responseUrl: `${BASE}/queue/req-launch-1`,
      },
      { video: { url: "https://media/v.mp4" } },
    );

    const handle = await launchVideo(
      { prompt: "a wave", model: "veo3-fast" },
      transport,
      BASE,
    );

    // Routed URL (Core capability route), NOT a fal-direct /run/<model> path.
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/capabilities/content.generation.video`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    // Video is async-only (no sync/async choice, unlike images), so the body carries
    // no `dispatch` field — `model` rides as a body field (a semantic alias here) and
    // the adapter resolves it server-side.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a wave",
      model: "veo3-fast",
    });
    expect(handle.requestId).toBe("req-launch-1");
  });

  it("dispatch.correlationId equals requestId and dispatch.resultSignal equals VIDEO_RESULT_SIGNAL", async () => {
    const { transport } = makeLaunchTransport(
      {
        requestId: "req-dispatch",
        responseUrl: `${BASE}/queue/req-dispatch`,
      },
      { video: { url: "https://media/v.mp4" } },
    );

    const handle = await launchVideo({ prompt: "a wave" }, transport, BASE);

    expect(handle.dispatch.correlationId).toBe("req-dispatch");
    expect(handle.dispatch.resultSignal).toBe(VIDEO_RESULT_SIGNAL);
  });

  it("VIDEO_RESULT_SIGNAL is the capability-stable terminal signal", () => {
    expect(VIDEO_RESULT_SIGNAL).toBe("contentGeneration.video.result");
  });

  it("includes x-sapiom-workflow-token when transport.resumeToken is set", async () => {
    const { transport, calls } = makeLaunchTransport(
      { requestId: "req-tok", responseUrl: `${BASE}/queue/req-tok` },
      { video: { url: "u" } },
      "tok-workflow-abc",
    );

    await launchVideo({ prompt: "x" }, transport, BASE);

    expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBe(
      "tok-workflow-abc",
    );
  });

  it("omits x-sapiom-workflow-token when resumeToken is not set", async () => {
    const { transport, calls } = makeLaunchTransport(
      { requestId: "req-notok", responseUrl: `${BASE}/queue/req-notok` },
      { video: { url: "u" } },
    );

    await launchVideo({ prompt: "x" }, transport, BASE);

    expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBeUndefined();
  });

  it("forwards the env token as x-sapiom-workflow-token", async () => {
    const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
    process.env[KEY] = "tok-env-video";
    try {
      const calls: FetchCall[] = [];
      const fetchMock = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init: RequestInit = {},
      ): Promise<Response> => {
        calls.push({ url: String(input), init });
        return jsonResponse({
          requestId: "req-env",
          responseUrl: `${BASE}/queue/req-env`,
        });
      }) as typeof globalThis.fetch;
      // Transport reads env var when resumeToken is not explicitly set
      const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });
      await launchVideo({ prompt: "x" }, transport, BASE);
      expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBe(
        "tok-env-video",
      );
    } finally {
      delete process.env[KEY];
    }
  });

  it("wait() polls the responseUrl and returns the mapped result", async () => {
    let polls = 0;
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (init.method === "POST") {
        return jsonResponse({
          requestId: "req-wait",
          responseUrl: `${BASE}/queue/req-wait`,
        });
      }
      polls += 1;
      return polls < 2
        ? jsonResponse({ status: "IN_PROGRESS" })
        : jsonResponse({
            video: { url: "https://media/v.mp4", content_type: "video/mp4" },
          });
    }) as typeof globalThis.fetch;
    const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });

    const handle = await launchVideo(
      { prompt: "a wave", pollIntervalMs: 1 },
      transport,
      BASE,
    );
    const result = await handle.wait({ pollMs: 1 });

    expect(result.video).toEqual({
      url: "https://media/v.mp4",
      contentType: "video/mp4",
    });
    expect(calls.filter((c) => c.init.method === "GET")).toHaveLength(2);
  });

  it("wait() maps fileId and passes storage on submit", async () => {
    const { transport, calls } = makeLaunchTransport(
      { requestId: "req-store", responseUrl: `${BASE}/queue/req-store` },
      { video: { url: "https://media/v.mp4", file_id: "f-store" } },
    );

    const handle = await launchVideo(
      { prompt: "x", storage: { visibility: "private" } },
      transport,
      BASE,
    );
    const result = await handle.wait({ pollMs: 1 });

    expect(result.video?.fileId).toBe("f-store");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      storage: { visibility: "private" },
    });
  });

  it("throws ContentGenerationHttpError when the submit fails — never polls", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ error: "bad model" }, { status: 422 }),
    ]);

    await expect(
      launchVideo({ prompt: "x" }, transport, BASE),
    ).rejects.toBeInstanceOf(ContentGenerationHttpError);
    expect(calls).toHaveLength(1);
  });

  it("wait() throws if the result isn't ready before the timeout", async () => {
    const { transport } = makeLaunchTransport(
      { requestId: "req-timeout", responseUrl: `${BASE}/queue/req-timeout` },
      { status: "IN_PROGRESS" },
    );

    const handle = await launchVideo({ prompt: "x" }, transport, BASE);
    await expect(handle.wait({ timeoutMs: 20, pollMs: 1 })).rejects.toThrow(
      /did not complete within/,
    );
  });

  it("explicit resumeToken wins over the ambient env token", async () => {
    const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
    process.env[KEY] = "tok-env-should-lose";
    try {
      const calls: FetchCall[] = [];
      const fetchMock = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init: RequestInit = {},
      ): Promise<Response> => {
        calls.push({ url: String(input), init });
        return jsonResponse({
          requestId: "req-explicit",
          responseUrl: `${BASE}/queue/req-explicit`,
        });
      }) as typeof globalThis.fetch;
      const transport = new Transport({
        apiKey: "test-key",
        resumeToken: "tok-explicit",
        fetch: fetchMock,
      });
      await launchVideo({ prompt: "x" }, transport, BASE);
      expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBe(
        "tok-explicit",
      );
    } finally {
      delete process.env[KEY];
    }
  });

  it("`video.launch` is the same operation as `launchVideo`", async () => {
    const { transport } = makeLaunchTransport(
      { requestId: "req-ns", responseUrl: `${BASE}/queue/req-ns` },
      { video: { url: "u" } },
    );

    const handle = await video.launch({ prompt: "x" }, transport, BASE);
    expect(handle.requestId).toBe("req-ns");
    expect(handle.dispatch.resultSignal).toBe(VIDEO_RESULT_SIGNAL);
  });
});

// ---------------------------------------------------------------------------
// createClient().contentGeneration.video.launch — binding
// ---------------------------------------------------------------------------

describe("createClient().contentGeneration.video.launch", () => {
  it("binds to the client credential, includes the workflow token header, and returns a handle", async () => {
    const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
    process.env[KEY] = "tok-client-bind";
    try {
      const calls: FetchCall[] = [];
      const fetchMock = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init: RequestInit = {},
      ): Promise<Response> => {
        calls.push({ url: String(input), init });
        return jsonResponse({
          requestId: "r-client",
          responseUrl: "https://api.sapiom.ai/queue/r-client",
        });
      }) as typeof globalThis.fetch;

      const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
      const handle = await sapiom.contentGeneration.video.launch({
        prompt: "x",
      });

      expect(handle.requestId).toBe("r-client");
      expect(handle.dispatch.resultSignal).toBe(VIDEO_RESULT_SIGNAL);
      expect(calls[0]!.url).toBe(
        "https://api.sapiom.ai/v1/capabilities/content.generation.video",
      );
      expect(headerOf(calls[0]!, "x-api-key")).toBe("client-key");
      expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
      expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBe(
        "tok-client-bind",
      );
    } finally {
      delete process.env[KEY];
    }
  });
});

// ---------------------------------------------------------------------------
// contentGeneration.images.launch() — routed async dispatch + resume token
// ---------------------------------------------------------------------------

describe("contentGeneration.images.launch()", () => {
  it("POSTs the routed capability with x-api-key, dispatch:'async', and returns a handle", async () => {
    const { transport, calls } = makeLaunchTransport(
      { requestId: "img-1", responseUrl: `${BASE}/queue/img-1` },
      { images: [{ url: "https://media/x.png" }] },
    );

    const handle = await launchImage({ prompt: "a red bike" }, transport, BASE);

    // Routed URL (Core capability route), NOT a fal-direct /run/<model> path.
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/capabilities/content.generation.images`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    // Routed auth header, not the gateway-direct one.
    expect(headerOf(calls[0]!, "x-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    // `dispatch: 'async'` is what selects the queue path over the sync 30s-capped one.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a red bike",
      dispatch: "async",
    });
    expect(handle.requestId).toBe("img-1");
  });

  it("dispatch.correlationId equals requestId and resultSignal equals IMAGE_RESULT_SIGNAL", async () => {
    const { transport } = makeLaunchTransport(
      { requestId: "img-disp", responseUrl: `${BASE}/queue/img-disp` },
      { images: [{ url: "u" }] },
    );

    const handle = await launchImage({ prompt: "a wave" }, transport, BASE);

    expect(handle.dispatch.correlationId).toBe("img-disp");
    expect(handle.dispatch.resultSignal).toBe(IMAGE_RESULT_SIGNAL);
  });

  it("IMAGE_RESULT_SIGNAL is the capability-stable terminal signal", () => {
    expect(IMAGE_RESULT_SIGNAL).toBe("contentGeneration.images.result");
  });

  it("accepts a statusUrl-only handle, deriving the poll URL by stripping /status", async () => {
    let polledUrl = "";
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = String(input);
      if (init.method === "POST") {
        return jsonResponse({
          requestId: "img-status-only",
          statusUrl: `${BASE}/queue/img-status-only/status`,
        });
      }
      polledUrl = url;
      return jsonResponse({ images: [{ url: "https://media/x.png" }] });
    }) as typeof globalThis.fetch;
    const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });

    const handle = await launchImage({ prompt: "x" }, transport, BASE);
    await expect(handle.wait({ pollMs: 1 })).resolves.toMatchObject({
      images: [{ url: "https://media/x.png" }],
    });
    expect(polledUrl).toBe(`${BASE}/queue/img-status-only`);
  });

  it("forwards numImages, params, model, and storage alongside dispatch:'async'", async () => {
    const { transport, calls } = makeLaunchTransport(
      { requestId: "img-fields", responseUrl: `${BASE}/queue/img-fields` },
      { images: [] },
    );

    await launchImage(
      {
        prompt: "x",
        numImages: 2,
        params: { image_size: "square" },
        model: "fal-ai/flux/dev",
        storage: { visibility: "private" },
      },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      dispatch: "async",
      numImages: 2,
      params: { image_size: "square" },
      model: "fal-ai/flux/dev",
      storage: { visibility: "private" },
    });
  });

  it("includes x-sapiom-workflow-token when transport.resumeToken is set", async () => {
    const { transport, calls } = makeLaunchTransport(
      { requestId: "img-tok", responseUrl: `${BASE}/queue/img-tok` },
      { images: [{ url: "u" }] },
      "tok-workflow-img",
    );

    await launchImage({ prompt: "x" }, transport, BASE);

    expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBe(
      "tok-workflow-img",
    );
  });

  it("omits x-sapiom-workflow-token when resumeToken is not set", async () => {
    const { transport, calls } = makeLaunchTransport(
      { requestId: "img-notok", responseUrl: `${BASE}/queue/img-notok` },
      { images: [{ url: "u" }] },
    );

    await launchImage({ prompt: "x" }, transport, BASE);

    expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBeUndefined();
  });

  it("wait() polls the responseUrl and returns the mapped result; maps fileId", async () => {
    let polls = 0;
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      if (init.method === "POST") {
        return jsonResponse({
          requestId: "img-wait",
          responseUrl: `${BASE}/queue/img-wait`,
        });
      }
      polls += 1;
      return polls < 2
        ? jsonResponse({ status: "IN_PROGRESS" })
        : jsonResponse({
            images: [{ url: "https://media/x.png", fileId: "f-img" }],
          });
    }) as typeof globalThis.fetch;
    const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });

    const handle = await launchImage({ prompt: "x" }, transport, BASE);
    const result = await handle.wait({ pollMs: 1 });

    expect(result.images?.[0]?.fileId).toBe("f-img");
    expect(calls.filter((c) => c.init.method === "GET")).toHaveLength(2);
  });

  it("throws ContentGenerationHttpError when the submit fails — never polls", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ error: "bad model" }, { status: 422 }),
    ]);

    await expect(
      launchImage({ prompt: "x" }, transport, BASE),
    ).rejects.toBeInstanceOf(ContentGenerationHttpError);
    expect(calls).toHaveLength(1);
  });

  it("wait() throws if the result isn't ready before the timeout", async () => {
    const { transport } = makeLaunchTransport(
      { requestId: "img-timeout", responseUrl: `${BASE}/queue/img-timeout` },
      { status: "IN_PROGRESS" },
    );

    const handle = await launchImage({ prompt: "x" }, transport, BASE);
    await expect(handle.wait({ timeoutMs: 20, pollMs: 1 })).rejects.toThrow(
      /did not complete within/,
    );
  });

  it("`images.launch` is the same operation as `launchImage`", async () => {
    const { transport } = makeLaunchTransport(
      { requestId: "img-ns", responseUrl: `${BASE}/queue/img-ns` },
      { images: [{ url: "u" }] },
    );

    const handle = await images.launch({ prompt: "x" }, transport, BASE);
    expect(handle.requestId).toBe("img-ns");
    expect(handle.dispatch.resultSignal).toBe(IMAGE_RESULT_SIGNAL);
  });
});

// ---------------------------------------------------------------------------
// SAP-2576 — per-generation cost envelope surfaced on results + launch handles
// ---------------------------------------------------------------------------

describe("cost envelope (SAP-2576)", () => {
  const COST = {
    estimateUsd: 0.4,
    currency: "USD",
    isEstimate: true,
    source: "quote",
    reference: "txn_abc123",
  } as const;

  it("createVideo threads the submit handle's cost + resolvedModel onto the polled result", async () => {
    const { transport } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "req-cost",
              responseUrl: `${BASE}/queue/req-cost`,
              resolvedModel: "seedance-fast",
              cost: COST,
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ video: { url: "https://media/v.mp4" } })
          : null,
    ]);

    const out = await createVideo(
      { prompt: "a wave", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    // The queue passthrough (the GET poll) carries neither cost nor resolvedModel — both are
    // threaded from the submit handle, so a reseller can price without a second API call.
    expect(out.resolvedModel).toBe("seedance-fast");
    expect(out.cost).toEqual(COST);
    expect(out.cost?.reference).toBe("txn_abc123");
    expect(out.video?.url).toBe("https://media/v.mp4");
  });

  it("createVideo surfaces resolvedModel with no cost when the quote was unavailable", async () => {
    const { transport } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "r",
              responseUrl: `${BASE}/queue/r`,
              // Contract: the router always echoes resolvedModel, even when the price join is down.
              resolvedModel: "veo3-fast",
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ video: { url: "https://media/v.mp4" } })
          : null,
    ]);

    const out = await createVideo(
      { prompt: "x", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    expect(out.resolvedModel).toBe("veo3-fast");
    expect(out.cost).toBeUndefined();
    expect(out.video?.url).toBe("https://media/v.mp4");
  });

  it("createVideo echoes a legacy raw provider id as resolvedModel", async () => {
    const { transport } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({
              requestId: "r-raw",
              responseUrl: `${BASE}/queue/r-raw`,
              resolvedModel: "fal-ai/veo3/fast",
            })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ video: { url: "https://media/v.mp4" } })
          : null,
    ]);

    const out = await createVideo(
      { prompt: "x", model: "fal-ai/veo3/fast", pollIntervalMs: 1 },
      transport,
      BASE,
    );

    expect(out.resolvedModel).toBe("fal-ai/veo3/fast");
  });

  it("launchVideo exposes cost + resolvedModel on the handle AND on the wait() result", async () => {
    const { transport } = makeLaunchTransport(
      {
        requestId: "req-lc",
        responseUrl: `${BASE}/queue/req-lc`,
        resolvedModel: "veo3-fast",
        cost: COST,
      },
      { video: { url: "https://media/v.mp4" } },
    );

    const handle = await launchVideo({ prompt: "x" }, transport, BASE);
    expect(handle.resolvedModel).toBe("veo3-fast");
    expect(handle.cost).toEqual(COST);

    const result = await handle.wait({ pollMs: 1 });
    expect(result.cost?.reference).toBe("txn_abc123");
    expect(result.resolvedModel).toBe("veo3-fast");
  });

  it("createImage surfaces the response body's cost + resolvedModel", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          images: [{ url: "https://media/x.png" }],
          resolvedModel: "flux-fast",
          cost: COST,
        }),
    ]);

    const out = await createImage({ prompt: "x" }, transport, BASE);
    expect(out.resolvedModel).toBe("flux-fast");
    expect(out.cost).toEqual(COST);
  });

  it("launchImage exposes cost + resolvedModel on the handle", async () => {
    const { transport } = makeLaunchTransport(
      {
        requestId: "img-c",
        responseUrl: `${BASE}/queue/img-c`,
        resolvedModel: "flux-fast",
        cost: COST,
      },
      { images: [{ url: "u" }] },
    );

    const handle = await launchImage({ prompt: "x" }, transport, BASE);
    expect(handle.resolvedModel).toBe("flux-fast");
    expect(handle.cost?.reference).toBe("txn_abc123");
  });
});

// ---------------------------------------------------------------------------
// E4 (SAP-2579) — neutral param vocabulary forwarded top-level (camelCase)
// ---------------------------------------------------------------------------

describe("neutral params (E4/SAP-2579)", () => {
  it("createImage forwards the image neutral params + passthrough top-level", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [], resolvedModel: "flux-fast" }),
    ]);

    await createImage(
      {
        prompt: "x",
        aspectRatio: "9:16",
        count: 2,
        seed: 7,
        negativePrompt: "blurry",
        referenceImage: "https://img/ref.png",
        outputFormat: "webp",
        passthrough: { guidance_scale: 3 },
      },
      transport,
      BASE,
    );

    // Every neutral field rides top-level camelCase (matching the router's ImageCreateRequest);
    // passthrough stays a nested object forwarded verbatim.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      aspectRatio: "9:16",
      count: 2,
      seed: 7,
      negativePrompt: "blurry",
      referenceImage: "https://img/ref.png",
      outputFormat: "webp",
      passthrough: { guidance_scale: 3 },
    });
  });

  it("createVideo forwards the video neutral params (the M1 headline call) top-level", async () => {
    const { transport, calls } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({ requestId: "r", responseUrl: `${BASE}/queue/r` })
          : null,
      (c) =>
        c.init.method === "GET"
          ? jsonResponse({ video: { url: "https://media/v.mp4" } })
          : null,
    ]);

    // The literal M1 promise: no provider model id, no per-model param folklore.
    await createVideo(
      {
        prompt: "a wave",
        aspectRatio: "9:16",
        audio: true,
        duration: 10,
        pollIntervalMs: 1,
      },
      transport,
      BASE,
    );

    // pollIntervalMs is a client-side control — it stays off the wire.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a wave",
      aspectRatio: "9:16",
      audio: true,
      duration: 10,
    });
  });

  it("launchImage + launchVideo forward neutral params alongside their dispatch shape", async () => {
    const img = makeLaunchTransport(
      { requestId: "i", responseUrl: `${BASE}/queue/i` },
      { images: [{ url: "u" }] },
    );
    await launchImage(
      { prompt: "x", aspectRatio: "1:1", count: 3 },
      img.transport,
      BASE,
    );
    expect(JSON.parse(img.calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      dispatch: "async",
      aspectRatio: "1:1",
      count: 3,
    });

    const vid = makeLaunchTransport(
      { requestId: "v", responseUrl: `${BASE}/queue/v` },
      { video: { url: "u" } },
    );
    await launchVideo(
      { prompt: "x", resolution: "1080p", negativePrompt: "text" },
      vid.transport,
      BASE,
    );
    expect(JSON.parse(vid.calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      resolution: "1080p",
      negativePrompt: "text",
    });
  });

  it("keeps the deprecated numImages/params working (forwarded verbatim)", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({ images: [] })]);

    await createImage(
      { prompt: "x", numImages: 4, params: { image_size: "square" } },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      numImages: 4,
      params: { image_size: "square" },
    });
  });

  it("drops an explicit null neutral field (JS caller) instead of sending it", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({ images: [] })]);

    await createImage(
      {
        prompt: "x",
        aspectRatio: null as unknown as undefined,
        count: null as unknown as undefined,
      },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ prompt: "x" });
  });
});

// ---------------------------------------------------------------------------
// toVideoResumePayload()
// ---------------------------------------------------------------------------

describe("toVideoResumePayload()", () => {
  const M = "veo3-fast";

  // SAP-2576: the durable resume payload MUST carry resolvedModel + cost, so a step that bills
  // in the resumed step (after generation) can still read cost.reference / resolvedModel.
  it("carries resolvedModel + cost onto the resume payload (the Polsia rebilling case)", () => {
    const payload = toVideoResumePayload({
      video: { url: "https://media/v.mp4", fileId: "f-1" },
      resolvedModel: M,
      cost: {
        estimateUsd: 0.4,
        currency: "USD",
        isEstimate: true,
        source: "quote",
        reference: "txn_abc123",
      },
    });
    expect(payload.resolvedModel).toBe(M);
    expect(payload.cost?.reference).toBe("txn_abc123");
    expect(payload.outputs).toEqual([{ fileId: "f-1" }]);
  });

  it("carries a reference-only cost envelope (quote unavailable, transaction still created)", () => {
    const payload = toVideoResumePayload({
      video: { url: "u" },
      resolvedModel: M,
      cost: { reference: "txn_only" },
    });
    expect(payload.cost).toEqual({ reference: "txn_only" });
    expect(payload.resolvedModel).toBe(M);
  });

  it("maps a video with fileId to outputs[0].fileId", () => {
    const payload = toVideoResumePayload({
      video: { url: "https://media/v.mp4", fileId: "f-1" },
      resolvedModel: M,
    });
    expect(payload).toEqual({ resolvedModel: M, outputs: [{ fileId: "f-1" }] });
  });

  it("maps a video with storageError to outputs[0].storageError", () => {
    const payload = toVideoResumePayload({
      video: { url: "https://media/v.mp4", storageError: "quota exceeded" },
      resolvedModel: M,
    });
    expect(payload).toEqual({
      resolvedModel: M,
      outputs: [{ storageError: "quota exceeded" }],
    });
  });

  it("maps a video with neither fileId nor storageError to an empty-field outputs[0]", () => {
    const payload = toVideoResumePayload({
      video: { url: "https://media/v.mp4" },
      resolvedModel: M,
    });
    expect(payload).toEqual({ resolvedModel: M, outputs: [{}] });
  });

  it("returns empty outputs when there is no video (metadata still present)", () => {
    const payload = toVideoResumePayload({ resolvedModel: M });
    expect(payload).toEqual({ resolvedModel: M, outputs: [] });
  });

  it("includes both fileId and storageError when both are present", () => {
    const payload = toVideoResumePayload({
      video: { url: "u", fileId: "f-2", storageError: "partial" },
      resolvedModel: M,
    });
    expect(payload).toEqual({
      resolvedModel: M,
      outputs: [{ fileId: "f-2", storageError: "partial" }],
    });
  });

  it("carries the convenience downloadUrl + its expiry alongside fileId", () => {
    const payload = toVideoResumePayload({
      video: {
        url: "u",
        fileId: "f-3",
        downloadUrl: "https://dl/f-3",
        downloadUrlExpiresAt: "2026-03-03T00:00:00Z",
      },
      resolvedModel: M,
    });
    expect(payload).toEqual({
      resolvedModel: M,
      outputs: [
        {
          fileId: "f-3",
          downloadUrl: "https://dl/f-3",
          downloadUrlExpiresAt: "2026-03-03T00:00:00Z",
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// toImageResumePayload()
// ---------------------------------------------------------------------------

describe("toImageResumePayload()", () => {
  const M = "flux-fast";

  it("carries resolvedModel + cost onto the resume payload (the Polsia rebilling case)", () => {
    const payload = toImageResumePayload({
      images: [{ url: "u1", fileId: "f-1" }],
      resolvedModel: M,
      cost: {
        estimateUsd: 0.02,
        currency: "USD",
        isEstimate: true,
        source: "quote",
        reference: "txn_img",
      },
    });
    expect(payload.resolvedModel).toBe(M);
    expect(payload.cost?.reference).toBe("txn_img");
    expect(payload.outputs).toEqual([{ fileId: "f-1" }]);
  });

  it("carries a reference-only cost envelope (quote unavailable, transaction still created)", () => {
    const payload = toImageResumePayload({
      images: [{ url: "u" }],
      resolvedModel: M,
      cost: { reference: "txn_only" },
    });
    expect(payload.cost).toEqual({ reference: "txn_only" });
    expect(payload.resolvedModel).toBe(M);
  });

  it("maps each image to an outputs[] entry (one per image, order preserved)", () => {
    const payload = toImageResumePayload({
      images: [
        { url: "u1", fileId: "f-1" },
        { url: "u2", fileId: "f-2", storageError: "partial" },
      ],
      resolvedModel: M,
    });
    expect(payload).toEqual({
      resolvedModel: M,
      outputs: [{ fileId: "f-1" }, { fileId: "f-2", storageError: "partial" }],
    });
  });

  it("returns empty outputs when there are no images (metadata still present)", () => {
    expect(toImageResumePayload({ resolvedModel: M })).toEqual({
      resolvedModel: M,
      outputs: [],
    });
    expect(toImageResumePayload({ images: [], resolvedModel: M })).toEqual({
      resolvedModel: M,
      outputs: [],
    });
  });

  it("carries the convenience downloadUrl + its expiry alongside fileId", () => {
    const payload = toImageResumePayload({
      images: [
        {
          url: "u",
          fileId: "f-3",
          downloadUrl: "https://dl/f-3",
          downloadUrlExpiresAt: "2026-03-03T00:00:00Z",
        },
      ],
      resolvedModel: M,
    });
    expect(payload).toEqual({
      resolvedModel: M,
      outputs: [
        {
          fileId: "f-3",
          downloadUrl: "https://dl/f-3",
          downloadUrlExpiresAt: "2026-03-03T00:00:00Z",
        },
      ],
    });
  });

  it("emits an empty-field entry for an image with no storage annotations", () => {
    const payload = toImageResumePayload({
      images: [{ url: "u" }],
      resolvedModel: M,
    });
    expect(payload).toEqual({ resolvedModel: M, outputs: [{}] });
  });
});

// ---------------------------------------------------------------------------
// prompt-guard: null / empty / non-string prompt throws before any fetch
// ---------------------------------------------------------------------------

describe("prompt-guard — createImage, launchImage, createVideo, launchVideo throw on invalid prompt", () => {
  const noFetch = (): never => {
    throw new Error("fetch should not be called with an invalid prompt");
  };
  const noFetchTransport = new Transport({
    apiKey: "test-key",
    fetch: noFetch as unknown as typeof globalThis.fetch,
  });

  for (const [label, prompt] of [
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["number", 42],
    ["object", {}],
  ] as const) {
    it(`createImage throws ContentGenerationHttpError(400) for prompt = ${label}`, async () => {
      await expect(
        createImage(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toBeInstanceOf(ContentGenerationHttpError);
      await expect(
        createImage(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it(`createVideo throws ContentGenerationHttpError(400) for prompt = ${label}`, async () => {
      await expect(
        createVideo(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toBeInstanceOf(ContentGenerationHttpError);
      await expect(
        createVideo(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it(`launchVideo throws ContentGenerationHttpError(400) for prompt = ${label}`, async () => {
      await expect(
        launchVideo(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toBeInstanceOf(ContentGenerationHttpError);
      await expect(
        launchVideo(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it(`launchImage throws ContentGenerationHttpError(400) for prompt = ${label}`, async () => {
      await expect(
        launchImage(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toBeInstanceOf(ContentGenerationHttpError);
      await expect(
        launchImage(
          { prompt: prompt as unknown as string },
          noFetchTransport,
          BASE,
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  }
});
