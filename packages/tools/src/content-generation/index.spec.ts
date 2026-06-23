import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import { images, createImage, ContentGenerationHttpError } from "./index.js";

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
  it("POSTs the default model with just the prompt + credential and returns the result verbatim", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          images: [{ url: "https://media/x.png", content_type: "image/png" }],
          seed: 7,
        }),
    ]);

    const out = await createImage({ prompt: "a red bike" }, transport, BASE);

    expect(out).toEqual({
      images: [{ url: "https://media/x.png", content_type: "image/png" }],
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

  it("forwards passthrough params and an explicit model (slashes preserved, no %2F)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await createImage(
      {
        prompt: "x",
        num_images: 3,
        image_size: "square",
        model: "/some/other/model/",
      },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/run/some/other/model`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      num_images: 3,
      image_size: "square",
    });
  });

  it("merges the optional `storage` param into the body; the image carries file_id", async () => {
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
    expect(out.images?.[0]?.file_id).toBe("f1");
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

  it("passes each image's own file_id / storage_error through on a multi-image response", async () => {
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
      { prompt: "x", num_images: 3, storage: {} },
      transport,
      BASE,
    );

    expect(out.images?.map((i) => i.file_id)).toEqual([
      "f-a",
      "f-b",
      undefined,
    ]);
    expect(out.images?.[2]?.storage_error).toBe("exceeded max upload size");
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
  it("binds to the client's credential + default generation host, merging storage", async () => {
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

    expect(out.images?.[0]?.file_id).toBe("f");
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
