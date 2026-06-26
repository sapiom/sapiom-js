import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import {
  images,
  createImage,
  createVideo,
  launchVideo,
  toVideoResumePayload,
  VIDEO_RESULT_SIGNAL,
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

  it("tolerates a transient non-ok poll, then returns once the result is ready", async () => {
    let polls = 0;
    const { transport } = makeTransport([
      (c) =>
        c.init.method === "POST"
          ? jsonResponse({ request_id: "req-5", response_url: `${BASE}/queue/req-5` })
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

// ---------------------------------------------------------------------------
// contentGeneration.video.launch() — dispatch handle + workflow resume token
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
    transport: new Transport({ apiKey: "test-key", fetch: fetchMock, resumeToken }),
    calls,
  };
}

describe("contentGeneration.video.launch()", () => {
  it("submits to the right URL and method, returns a handle with requestId and dispatch", async () => {
    const { transport, calls } = makeLaunchTransport(
      { request_id: "req-launch-1", response_url: `${BASE}/queue/req-launch-1` },
      { video: { url: "https://media/v.mp4" } },
    );

    const handle = await launchVideo({ prompt: "a wave" }, transport, BASE);

    expect(calls[0]!.url).toBe(`${BASE}/run/fal-ai/veo3/fast`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(handle.requestId).toBe("req-launch-1");
  });

  it("dispatch.correlationId equals requestId and dispatch.resultSignal equals VIDEO_RESULT_SIGNAL", async () => {
    const { transport } = makeLaunchTransport(
      { request_id: "req-dispatch", response_url: `${BASE}/queue/req-dispatch` },
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
      { request_id: "req-tok", response_url: `${BASE}/queue/req-tok` },
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
      { request_id: "req-notok", response_url: `${BASE}/queue/req-notok` },
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
        return jsonResponse({ request_id: "req-env", response_url: `${BASE}/queue/req-env` });
      }) as typeof globalThis.fetch;
      // Transport reads env var when resumeToken is not explicitly set
      const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });
      await launchVideo({ prompt: "x" }, transport, BASE);
      expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBe("tok-env-video");
    } finally {
      delete process.env[KEY];
    }
  });

  it("wait() polls the response_url and returns the mapped result", async () => {
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
          request_id: "req-wait",
          response_url: `${BASE}/queue/req-wait`,
        });
      }
      polls += 1;
      return polls < 2
        ? jsonResponse({ status: "IN_PROGRESS" })
        : jsonResponse({ video: { url: "https://media/v.mp4", content_type: "video/mp4" } });
    }) as typeof globalThis.fetch;
    const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });

    const handle = await launchVideo({ prompt: "a wave", pollIntervalMs: 1 } as Parameters<typeof launchVideo>[0], transport, BASE);
    const result = await handle.wait({ pollMs: 1 });

    expect(result.video).toEqual({
      url: "https://media/v.mp4",
      contentType: "video/mp4",
    });
    expect(calls.filter((c) => c.init.method === "GET")).toHaveLength(2);
  });

  it("wait() maps fileId and passes storage on submit", async () => {
    const { transport, calls } = makeLaunchTransport(
      { request_id: "req-store", response_url: `${BASE}/queue/req-store` },
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
          request_id: "r-client",
          response_url: "https://fal.services.sapiom.ai/queue/r-client",
        });
      }) as typeof globalThis.fetch;

      const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
      const handle = await sapiom.contentGeneration.video.launch({ prompt: "x" });

      expect(handle.requestId).toBe("r-client");
      expect(handle.dispatch.resultSignal).toBe(VIDEO_RESULT_SIGNAL);
      expect(calls[0]!.url).toBe(
        "https://fal.services.sapiom.ai/run/fal-ai/veo3/fast",
      );
      expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("client-key");
      expect(headerOf(calls[0]!, "x-sapiom-workflow-token")).toBe("tok-client-bind");
    } finally {
      delete process.env[KEY];
    }
  });
});

// ---------------------------------------------------------------------------
// toVideoResumePayload()
// ---------------------------------------------------------------------------

describe("toVideoResumePayload()", () => {
  it("maps a video with fileId to outputs[0].fileId", () => {
    const payload = toVideoResumePayload({
      video: { url: "https://media/v.mp4", fileId: "f-1" },
    });
    expect(payload).toEqual({ outputs: [{ fileId: "f-1" }] });
  });

  it("maps a video with storageError to outputs[0].storageError", () => {
    const payload = toVideoResumePayload({
      video: { url: "https://media/v.mp4", storageError: "quota exceeded" },
    });
    expect(payload).toEqual({ outputs: [{ storageError: "quota exceeded" }] });
  });

  it("maps a video with neither fileId nor storageError to an empty-field outputs[0]", () => {
    const payload = toVideoResumePayload({ video: { url: "https://media/v.mp4" } });
    expect(payload).toEqual({ outputs: [{}] });
  });

  it("returns empty outputs when there is no video", () => {
    const payload = toVideoResumePayload({});
    expect(payload).toEqual({ outputs: [] });
  });

  it("includes both fileId and storageError when both are present", () => {
    const payload = toVideoResumePayload({
      video: { url: "u", fileId: "f-2", storageError: "partial" },
    });
    expect(payload).toEqual({
      outputs: [{ fileId: "f-2", storageError: "partial" }],
    });
  });
});

// ---------------------------------------------------------------------------
// prompt-guard: null / empty / non-string prompt throws before any fetch
// ---------------------------------------------------------------------------

describe("prompt-guard — createImage, createVideo, launchVideo throw on invalid prompt", () => {
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
  }
});
