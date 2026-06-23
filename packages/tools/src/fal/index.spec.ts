import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as fal from "./index.js";
import { FalHttpError } from "./errors.js";

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
// fal.run()
// ---------------------------------------------------------------------------

describe("fal.run()", () => {
  it("POSTs /run/<model> with the Fal input + credential and returns the response verbatim", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          images: [
            {
              url: "https://fal.media/x.png",
              content_type: "image/png",
              width: 512,
              height: 512,
            },
          ],
          seed: 42,
        }),
    ]);

    const out = await fal.run(
      {
        model: "fal-ai/flux/schnell",
        input: { prompt: "a red bike", num_images: 1 },
      },
      transport,
      BASE,
    );

    // Passthrough: Fal-native shape returned verbatim, including non-image fields.
    expect(out).toEqual({
      images: [
        {
          url: "https://fal.media/x.png",
          content_type: "image/png",
          width: 512,
          height: 512,
        },
      ],
      seed: 42,
    });

    expect(calls[0]!.url).toBe(`${BASE}/run/fal-ai/flux/schnell`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a red bike",
      num_images: 1,
    });
  });

  it("merges the optional `storage` param into the request body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [{ url: "u", file_id: "f1" }] }),
    ]);

    const out = await fal.run(
      {
        model: "fal-ai/flux/schnell",
        input: { prompt: "x" },
        storage: { visibility: "public" },
      },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "x",
      storage: { visibility: "public" },
    });
    expect(out.images?.[0]?.file_id).toBe("f1");
  });

  it("omits `storage` from the body when not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await fal.run(
      { model: "fal-ai/flux/schnell", input: { prompt: "x" } },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ prompt: "x" });
    expect(body).not.toHaveProperty("storage");
  });

  it("treats a null `storage` (JS caller bypassing types) as absent — no null leaks upstream", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await fal.run(
      {
        model: "fal-ai/flux/schnell",
        input: { prompt: "x" },
        storage: null as unknown as undefined,
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ prompt: "x" });
    expect(body).not.toHaveProperty("storage");
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

    const out = await fal.run(
      {
        model: "fal-ai/flux/schnell",
        input: { prompt: "x", num_images: 3 },
        storage: {},
      },
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

  it("preserves '/' in the model path (no %2F) and drops empty segments", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ images: [] }),
    ]);

    await fal.run(
      {
        model: "/fal-ai/flux-pro/kontext/text-to-image/",
        input: { prompt: "x" },
      },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(
      `${BASE}/run/fal-ai/flux-pro/kontext/text-to-image`,
    );
  });

  it("throws FalHttpError (with status + body) on a non-2xx — e.g. storage on an async model → 400", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({
            message: "storage on asynchronous (queued) Fal models …",
            error: "Bad Request",
            statusCode: 400,
          }),
          { status: 400 },
        ),
    ]);

    await expect(
      fal.run(
        { model: "fal-ai/veo3/fast", input: { prompt: "x" }, storage: {} },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({
      name: "FalHttpError",
      status: 400,
      body: { error: "Bad Request" },
    });
    await expect(
      fal.run(
        { model: "fal-ai/veo3/fast", input: { prompt: "x" }, storage: {} },
        transport,
        BASE,
      ),
    ).rejects.toBeInstanceOf(FalHttpError);
  });

  it("throws a clear error (not a TypeError) when model is empty / all-slashes / nullish", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      fal.run({ model: "", input: { prompt: "x" } }, transport, BASE),
    ).rejects.toThrow(/model.*required/i);
    await expect(
      fal.run({ model: "///", input: { prompt: "x" } }, transport, BASE),
    ).rejects.toThrow(/model.*required/i);
    // JS caller bypassing the types — a clean error, not "Cannot read properties of undefined".
    await expect(
      fal.run(
        { model: undefined as unknown as string, input: {} },
        transport,
        BASE,
      ),
    ).rejects.toThrow(/model.*required/i);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createClient().fal — binding
// ---------------------------------------------------------------------------

describe("createClient().fal", () => {
  it("binds run() to the client's credential + default Fal host, merging storage", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      return jsonResponse({ images: [{ url: "u", file_id: "f" }] });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
    const out = await sapiom.fal.run({
      model: "fal-ai/flux/schnell",
      input: { prompt: "x" },
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
