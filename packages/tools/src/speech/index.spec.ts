import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as speech from "./index.js";
import { SpeechHttpError } from "./errors.js";
import { DEFAULT_VOICE } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers — capability fns are tested directly with a real Transport plus a
// scripted fetch mock (URL/method/header/body assertions are exact, and we
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
// tts.create / createSpeech()
// ---------------------------------------------------------------------------

describe("speech.tts.create()", () => {
  it("POSTs /v1/text-to-speech/:voice with JSON body + credential and returns mapped result", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          { url: "https://cdn.example.com/audio.mp3", expiresAt: "2026-07-10T00:00:00Z" },
          { status: 200 },
        ),
    ]);

    const result = await speech.createSpeech(
      { text: "Hello world", voice: "Aria" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/text-to-speech/Aria`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(headerOf(calls[0]!, "accept")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ text: "Hello world" });

    expect(result.url).toBe("https://cdn.example.com/audio.mp3");
    expect(result.expiresAt).toBe("2026-07-10T00:00:00Z");
    expect(result.fileId).toBeUndefined();
    expect(result.storageError).toBeUndefined();
  });

  it("uses the DEFAULT_VOICE when voice is omitted", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ url: "https://cdn.example.com/audio.mp3" }),
    ]);

    await speech.createSpeech({ text: "Hello" }, transport, BASE);

    expect(calls[0]!.url).toBe(
      `${BASE}/v1/text-to-speech/${encodeURIComponent(DEFAULT_VOICE)}`,
    );
  });

  it("URL-encodes the voice in the path segment", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ url: "https://cdn.example.com/audio.mp3" }),
    ]);

    await speech.createSpeech(
      { text: "Hello", voice: "Some Voice/ID" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(
      `${BASE}/v1/text-to-speech/${encodeURIComponent("Some Voice/ID")}`,
    );
  });

  it("includes extra params in the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ url: "https://cdn.example.com/audio.mp3" }),
    ]);

    await speech.createSpeech(
      { text: "Hello", voice: "Aria", params: { stability: 0.5, speed: 1.2 } },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.text).toBe("Hello");
    expect(body.stability).toBe(0.5);
    expect(body.speed).toBe(1.2);
  });

  it("includes storage in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          { url: "https://cdn.example.com/audio.mp3", file_id: "file_abc123" },
          { status: 200 },
        ),
    ]);

    const result = await speech.createSpeech(
      {
        text: "Hello",
        voice: "Aria",
        storage: { visibility: "private" },
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.storage).toEqual({ visibility: "private" });
    expect(result.fileId).toBe("file_abc123");
  });

  it("maps file_id → fileId on the result", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          url: "https://cdn.example.com/audio.mp3",
          file_id: "file_xyz789",
        }),
    ]);

    const result = await speech.createSpeech(
      { text: "Hi", storage: { visibility: "private" } },
      transport,
      BASE,
    );

    expect(result.fileId).toBe("file_xyz789");
    expect((result as Record<string, unknown>).file_id).toBeUndefined();
  });

  it("maps storage_error → storageError on the result", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          url: "https://cdn.example.com/audio.mp3",
          storage_error: "quota exceeded",
        }),
    ]);

    const result = await speech.createSpeech(
      { text: "Hi", storage: { visibility: "private" } },
      transport,
      BASE,
    );

    expect(result.storageError).toBe("quota exceeded");
    expect((result as Record<string, unknown>).storage_error).toBeUndefined();
  });

  it("passes url and expiresAt through unchanged", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          url: "https://cdn.example.com/audio.mp3",
          expiresAt: "2026-07-10T12:00:00Z",
        }),
    ]);

    const result = await speech.createSpeech({ text: "Hi" }, transport, BASE);
    expect(result.url).toBe("https://cdn.example.com/audio.mp3");
    expect(result.expiresAt).toBe("2026-07-10T12:00:00Z");
  });

  it("omits storage from body when storage is not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ url: "https://cdn.example.com/audio.mp3" }),
    ]);

    await speech.createSpeech({ text: "Hello" }, transport, BASE);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).not.toHaveProperty("storage");
  });

  it("throws SpeechHttpError (before any fetch) when text is empty", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      speech.createSpeech({ text: "" }, transport, BASE),
    ).rejects.toMatchObject({ name: "SpeechHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws SpeechHttpError (before any fetch) when text is missing", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      speech.createSpeech(
        { text: undefined as unknown as string },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "SpeechHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws SpeechHttpError (before any fetch) when text is whitespace only", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      speech.createSpeech({ text: "   " }, transport, BASE),
    ).rejects.toBeInstanceOf(SpeechHttpError);
    expect(calls.length).toBe(0);
  });

  it("throws SpeechHttpError with status + body on a non-2xx response", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "voice not found" }), {
          status: 404,
        }),
    ]);

    await expect(
      speech.createSpeech({ text: "Hello", voice: "Unknown" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "SpeechHttpError",
      status: 404,
      body: { message: "voice not found" },
    });
    await expect(
      speech.createSpeech({ text: "Hello" }, transport, BASE),
    ).rejects.toBeInstanceOf(SpeechHttpError);
  });
});

// ---------------------------------------------------------------------------
// soundEffects.create / createSoundEffect()
// ---------------------------------------------------------------------------

describe("speech.soundEffects.create()", () => {
  it("POSTs /v1/sound-generation with text and returns mapped result", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          { url: "https://cdn.example.com/sfx.mp3", expiresAt: "2026-07-10T00:00:00Z" },
          { status: 200 },
        ),
    ]);

    const result = await speech.createSoundEffect(
      { text: "thunder clap" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/sound-generation`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ text: "thunder clap" });

    expect(result.url).toBe("https://cdn.example.com/sfx.mp3");
    expect(result.expiresAt).toBe("2026-07-10T00:00:00Z");
  });

  it("maps durationSeconds → duration_seconds in the request body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ url: "https://cdn.example.com/sfx.mp3" }),
    ]);

    await speech.createSoundEffect(
      { text: "rain on leaves", durationSeconds: 4.5 },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.duration_seconds).toBe(4.5);
    expect(body).not.toHaveProperty("durationSeconds");
  });

  it("omits duration_seconds when durationSeconds is not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ url: "https://cdn.example.com/sfx.mp3" }),
    ]);

    await speech.createSoundEffect({ text: "wind" }, transport, BASE);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).not.toHaveProperty("duration_seconds");
    expect(body).not.toHaveProperty("durationSeconds");
  });

  it("includes extra params in the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ url: "https://cdn.example.com/sfx.mp3" }),
    ]);

    await speech.createSoundEffect(
      { text: "thunder", params: { seed: 42 } },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.seed).toBe(42);
  });

  it("includes storage in the body and maps file_id → fileId on result", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          url: "https://cdn.example.com/sfx.mp3",
          file_id: "file_sfx123",
        }),
    ]);

    const result = await speech.createSoundEffect(
      {
        text: "thunder",
        storage: { visibility: "public" },
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.storage).toEqual({ visibility: "public" });
    expect(result.fileId).toBe("file_sfx123");
  });

  it("throws SpeechHttpError (before any fetch) when text is empty", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      speech.createSoundEffect({ text: "" }, transport, BASE),
    ).rejects.toMatchObject({ name: "SpeechHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws SpeechHttpError on a non-2xx response", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "rate limit exceeded" }), {
          status: 429,
        }),
    ]);

    await expect(
      speech.createSoundEffect({ text: "thunder" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "SpeechHttpError",
      status: 429,
    });
  });
});

// ---------------------------------------------------------------------------
// voices.list / listVoices()
// ---------------------------------------------------------------------------

describe("speech.voices.list()", () => {
  it("GETs /v2/voices and returns mapped voices array", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          voices: [
            { voice_id: "v1", name: "Aria" },
            { voice_id: "v2", name: "Rachel" },
          ],
        }),
    ]);

    const result = await speech.listVoices(transport, BASE);

    expect(calls[0]!.url).toBe(`${BASE}/v2/voices`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");

    expect(result.voices).toHaveLength(2);
    expect(result.voices[0]).toEqual({ voiceId: "v1", name: "Aria" });
    expect(result.voices[1]).toEqual({ voiceId: "v2", name: "Rachel" });
  });

  it("maps voice_id → voiceId on each voice", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          voices: [{ voice_id: "abc123", name: "Sam" }],
        }),
    ]);

    const result = await speech.listVoices(transport, BASE);
    expect(result.voices[0]!.voiceId).toBe("abc123");
    expect((result.voices[0] as Record<string, unknown>).voice_id).toBeUndefined();
  });

  it("handles a camelCase voiceId field from the response", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          voices: [{ voiceId: "xyz789", name: "Emma" }],
        }),
    ]);

    const result = await speech.listVoices(transport, BASE);
    expect(result.voices[0]!.voiceId).toBe("xyz789");
  });

  it("returns an empty voices array when the response has no voices", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({}),
    ]);

    const result = await speech.listVoices(transport, BASE);
    expect(result.voices).toEqual([]);
  });

  it("throws SpeechHttpError on a non-2xx response", async () => {
    const { transport } = makeTransport([
      () => new Response("unauthorized", { status: 401 }),
    ]);

    await expect(
      speech.listVoices(transport, BASE),
    ).rejects.toMatchObject({ name: "SpeechHttpError", status: 401 });
    await expect(
      speech.listVoices(transport, BASE),
    ).rejects.toBeInstanceOf(SpeechHttpError);
  });
});

// ---------------------------------------------------------------------------
// Client wiring + auth
// ---------------------------------------------------------------------------

describe("speech — client wiring + credential", () => {
  it("createClient().speech routes tts.create/soundEffects.create/voices.list with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      return jsonResponse({ url: "https://cdn.example.com/audio.mp3" });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.speech.tts.create({ text: "Hello" });
    await sapiom.speech.soundEffects.create({ text: "thunder" });
    await sapiom.speech.voices.list();

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
    expect(calls[0]!.url).toContain(
      "elevenlabs.services.sapiom.ai/v1/text-to-speech/",
    );
    expect(calls[1]!.url).toContain(
      "elevenlabs.services.sapiom.ai/v1/sound-generation",
    );
    expect(calls[2]!.url).toContain(
      "elevenlabs.services.sapiom.ai/v2/voices",
    );
  });

  it("throws a clear error when no tenant credential is configured", async () => {
    const saved = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];
    try {
      const transport = new Transport({
        fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
      });
      await expect(
        speech.listVoices(transport, BASE),
      ).rejects.toThrow(/no tenant credential/i);
    } finally {
      if (saved !== undefined) process.env["SAPIOM_API_KEY"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Namespace exports (tts / soundEffects / voices)
// ---------------------------------------------------------------------------

describe("speech — namespace exports", () => {
  it("tts.create is the same function as createSpeech", () => {
    expect(speech.tts.create).toBe(speech.createSpeech);
  });

  it("soundEffects.create is the same function as createSoundEffect", () => {
    expect(speech.soundEffects.create).toBe(speech.createSoundEffect);
  });

  it("voices.list is the same function as listVoices", () => {
    expect(speech.voices.list).toBe(speech.listVoices);
  });
});

// ---------------------------------------------------------------------------
// SpeechHttpError
// ---------------------------------------------------------------------------

describe("SpeechHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new SpeechHttpError("something went wrong", 422, {
      message: "invalid",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SpeechHttpError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ message: "invalid" });
    expect(err.name).toBe("SpeechHttpError");
  });
});
