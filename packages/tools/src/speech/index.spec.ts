import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as speech from "./index.js";
import { SpeechHttpError } from "./errors.js";

const RACHEL_ID = "21m00Tcm4TlvDq8ikWAM";
const ARIA_ID = "9BWtsMINqrJLrRacOk9x";
const AUDIO = {
  url: "https://example.test/audio.mp3",
  expiresAt: "2026-10-06T00:00:00Z",
  fileId: "file-audio",
  metadata: { format: "mp3" },
};
interface RequestRecord {
  path: string;
  method?: string;
  headers: IncomingHttpHeaders;
  body: { cursor?: string; [k: string]: unknown };
}
let server: Server;
let baseUrl: string;
let requests: RequestRecord[];
let respond: (request: RequestRecord) => { status: number; body: unknown };
const savedEnv = process.env;
const nativeFetch = globalThis.fetch;

// The server supplies Core response fixtures. The SDK uses real HTTP and its
// real transport. The fetch guard prevents any test from reaching production.
const localFetch: typeof fetch = (input, init) => {
  if (new URL(String(input)).origin !== baseUrl) {
    throw new Error("Speech test attempted a non-local request");
  }
  return nativeFetch(input, init);
};
const transport = () =>
  new Transport({ apiKey: "test-key", fetch: localFetch });
const lastBody = () => requests[requests.length - 1]!.body;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request: RequestRecord = {
      path: req.url ?? "",
      method: req.method,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
    };
    requests.push(request);
    const result = respond(request);
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  process.env = {
    ...savedEnv,
    SAPIOM_BASE_URL: baseUrl,
    // Speech must ignore this; the exact-path checks fail on any /legacy request.
    SAPIOM_SPEECH_URL: `${baseUrl}/legacy`,
  };
  requests = [];
  respond = ({ path }) => {
    if (path === "/v1/capabilities/speech.voices.list") {
      return { status: 201, body: { voices: [] } };
    }
    if (
      path === "/v1/capabilities/speech.tts" ||
      path === "/v1/capabilities/speech.sound-effects"
    ) {
      return { status: 201, body: AUDIO };
    }
    return { status: 404, body: { error: "unexpected_route" } };
  };
});
afterEach(() => {
  process.env = savedEnv;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Core speech HTTP contract", () => {
  it.each(["legacy", "executions"] as const)(
    "routes all client methods through Core with %s delivery and identity",
    async (capabilityDelivery) => {
      // The shared _client specs cover the full attribution header set; this
      // pins the speech identity that SAP-3285 requires.
      const client = createClient({
        apiKey: "client-key",
        fetch: localFetch,
        coreBaseUrl: `${baseUrl}/`,
        capabilityDelivery,
      }).withAttribution({ agentName: "speech-agent", executionId: "run-1" });
      await client.speech.textToSpeech.create({ text: "Hello" });
      await client.speech.soundEffects.create({ text: "Bell" });
      await client.speech.voices.list();
      expect(requests.map((r) => r.path)).toEqual([
        "/v1/capabilities/speech.tts",
        "/v1/capabilities/speech.sound-effects",
        "/v1/capabilities/speech.voices.list",
      ]);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.headers).toMatchObject({
          "content-type": "application/json",
          "x-api-key": "client-key",
          "x-sapiom-agent-name": "speech-agent",
          "x-sapiom-execution-id": "run-1",
        });
        expect(request.headers["x-sapiom-api-key"]).toBeUndefined();
        expect(request.headers["x-sapiom-client"]).toMatch(/^sapiom-tools\//);
      }
      await client.shutdown();
    },
  );

  it("uses ambient credentials and attribution and resolves the Core origin at call time", async () => {
    await jest.isolateModulesAsync(async () => {
      // Import before the runtime selects Core. This must not freeze the origin.
      delete process.env.SAPIOM_BASE_URL;
      const ambient = await import("./index.js");
      process.env.SAPIOM_BASE_URL = baseUrl;
      process.env.SAPIOM_API_KEY = "ambient-key";
      process.env.SAPIOM_AGENT_NAME = "ambient-agent";
      process.env.SAPIOM_EXECUTION_ID = "ambient-run";
      globalThis.fetch = localFetch;
      try {
        await ambient.textToSpeech.create({ text: "Hi" });
        await ambient.soundEffects.create({ text: "Wind" });
        await ambient.voices.list();
      } finally {
        globalThis.fetch = nativeFetch;
      }
    });
    expect(requests).toHaveLength(3);
    for (const r of requests) {
      expect(r.path).toMatch(/^\/v1\/capabilities\/speech\./);
      expect(r.headers).toMatchObject({
        "x-api-key": "ambient-key",
        "x-sapiom-agent-name": "ambient-agent",
        "x-sapiom-execution-id": "ambient-run",
      });
    }
  });

  it("keeps the public aliases and uses Core's Rachel default without a catalog lookup", async () => {
    expect(speech.DEFAULT_VOICE).toBe(RACHEL_ID);
    expect(speech.textToSpeech.create).toBe(speech.createSpeech);
    expect(speech.soundEffects.create).toBe(speech.createSoundEffect);
    expect(speech.voices.list).toBe(speech.listVoices);
    expect(
      await speech.createSpeech({ text: "Hello" }, transport(), baseUrl),
    ).toEqual(AUDIO);
    expect(requests).toHaveLength(1);
    expect(lastBody()).toEqual({ text: "Hello" });
  });

  it.each([RACHEL_ID, ARIA_ID, "custom_voice-id"])(
    "passes voice ID %s unchanged without depending on voice listing",
    async (voice) => {
      respond = ({ path }) =>
        path.endsWith("voices.list")
          ? { status: 503, body: { code: "unavailable" } }
          : { status: 201, body: AUDIO };
      await speech.createSpeech({ text: "Hi", voice }, transport(), baseUrl);
      expect(requests.map((r) => r.path)).toEqual([
        "/v1/capabilities/speech.tts",
      ]);
      expect(lastBody()).toEqual({ text: "Hi", voice });
    },
  );

  it("sends the top-level model and keeps provider options nested under params", async () => {
    const input = {
      text: "REAL",
      voice: ARIA_ID,
      model: "eleven_flash_v2_5",
      storage: { visibility: "private" as const },
      idempotencyKey: "tts-request",
      params: {
        text: "INJECTED",
        voice: "INJECTED",
        idempotencyKey: "INJECTED",
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, speed: 1.2 },
        output_format: "mp3_44100_128",
      },
    };
    await speech.createSpeech(input, transport(), baseUrl);
    expect(requests).toHaveLength(1);
    expect(lastBody()).toEqual(input);
  });

  it.each(["Rachel", "Aria", "ProfessionalNarrator"])(
    "does not resolve or alias %s and preserves the Core error",
    async (voice) => {
      respond = () => ({ status: 404, body: { code: "upstream_rejected" } });
      await expect(
        speech.createSpeech({ text: "Hi", voice }, transport(), baseUrl),
      ).rejects.toMatchObject({
        name: "SpeechHttpError",
        status: 404,
        body: { code: "upstream_rejected" },
      });
      expect(requests.map((r) => r.path)).toEqual([
        "/v1/capabilities/speech.tts",
      ]);
      expect(lastBody().voice).toBe(voice);
    },
  );

  it.each([
    [4.5, 2],
    [undefined, 2],
    [null, 2],
    [undefined, undefined],
    [null, null],
  ])(
    "forwards durationSeconds=%s and params.duration_seconds=%s for Core to apply precedence",
    async (durationSeconds, duration) => {
      const input = {
        text: "Bell",
        durationSeconds,
        params: { duration_seconds: duration },
      };
      await speech.createSoundEffect(input, transport(), baseUrl);
      // toEqual treats undefined input fields as absent from the JSON body.
      expect(lastBody()).toEqual(input);
      expect(requests[0]!.path).toBe("/v1/capabilities/speech.sound-effects");
    },
  );

  it("keeps automatic sound effects and model options with durable camelCase fields", async () => {
    const input = {
      text: "Wind",
      model: "eleven_text_to_sound_v2",
      storage: { visibility: "public" as const },
      idempotencyKey: "sfx-request",
      params: {
        prompt_influence: 0.3,
        text: "INJECTED",
      },
    };
    expect(await speech.createSoundEffect(input, transport(), baseUrl)).toEqual(
      AUDIO,
    );
    expect(lastBody()).toEqual(input);
  });

  it.each([speech.createSpeech, speech.createSoundEffect])(
    "keeps stored-file-only, temporary-only, and storage-error responses",
    async (create) => {
      for (const body of [
        { fileId: "durable-only", metadata: { format: "mp3" } },
        { url: AUDIO.url, expiresAt: AUDIO.expiresAt },
        {
          url: AUDIO.url,
          expiresAt: AUDIO.expiresAt,
          storageError: "storage unavailable",
          metadata: { format: "mp3" },
        },
      ]) {
        respond = () => ({ status: 201, body });
        expect(
          await create(
            { text: "Hi", storage: { visibility: "private" } },
            transport(),
            baseUrl,
          ),
        ).toEqual(body);
      }
    },
  );

  it("follows Core's cursor across pages and keeps voice metadata", async () => {
    respond = ({ body }) => ({
      status: 201,
      body: body.cursor
        ? { voices: [{ voiceId: RACHEL_ID, name: "Rachel" }] }
        : {
            voices: [
              {
                voiceId: ARIA_ID,
                name: "Aria",
                labels: { accent: "American" },
              },
            ],
            nextCursor: "page-2",
          },
    });
    expect(await speech.listVoices(transport(), baseUrl)).toEqual({
      voices: [
        { voiceId: ARIA_ID, name: "Aria", labels: { accent: "American" } },
        { voiceId: RACHEL_ID, name: "Rachel" },
      ],
    });
    expect(requests.map((r) => r.body)).toEqual([{}, { cursor: "page-2" }]);
  });

  it("rejects a repeated cursor instead of returning a partial list", async () => {
    respond = () => ({
      status: 201,
      body: {
        voices: [{ voiceId: ARIA_ID, name: "Aria" }],
        nextCursor: "repeated",
      },
    });
    await expect(speech.listVoices(transport(), baseUrl)).rejects.toMatchObject(
      {
        name: "SpeechHttpError",
        status: 502,
        body: { error: "repeated_cursor", cursor: "repeated" },
      },
    );
    expect(requests).toHaveLength(2);
  });

  it("throws instead of returning a partial list when a later page fails", async () => {
    respond = ({ body }) =>
      body.cursor
        ? { status: 503, body: { code: "unavailable" } }
        : {
            status: 201,
            body: {
              voices: [{ voiceId: ARIA_ID, name: "Aria" }],
              nextCursor: "page-2",
            },
          };
    await expect(speech.listVoices(transport(), baseUrl)).rejects.toMatchObject(
      { name: "SpeechHttpError", status: 503 },
    );
    expect(requests).toHaveLength(2);
  });

  it("preserves a valid empty voice catalog", async () => {
    respond = () => ({ status: 201, body: { voices: [] } });
    expect(await speech.listVoices(transport(), baseUrl)).toEqual({
      voices: [],
    });
  });

  it.each(["", "   ", undefined, 42])(
    "rejects invalid text %s before HTTP",
    async (text) => {
      for (const create of [speech.createSpeech, speech.createSoundEffect]) {
        await expect(
          create({ text: text as string }, transport(), baseUrl),
        ).rejects.toMatchObject({
          name: "SpeechHttpError",
          status: 400,
          body: { error: "invalid_text" },
        });
      }
      expect(requests).toEqual([]);
    },
  );

  // capability-call.spec covers status-agnostic error mapping; this pins the
  // speech error type on each route.
  it("keeps typed errors, status, and JSON body on all three routes", async () => {
    const status = 422;
    const body = { code: "request_failed", message: "Request failed." };
    respond = () => ({ status, body });
    const calls = [
      () => speech.createSpeech({ text: "Hi" }, transport(), baseUrl),
      () => speech.createSoundEffect({ text: "Bell" }, transport(), baseUrl),
      () => speech.listVoices(transport(), baseUrl),
    ];
    for (const call of calls) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SpeechHttpError);
      expect(error).toMatchObject({ status, body });
    }
    expect(requests).toHaveLength(3);
  });

  it("keeps raw-text errors and the operation prefix without legacy fallback", async () => {
    respond = () => ({ status: 502, body: "temporarily unavailable" });
    await expect(
      speech.createSoundEffect({ text: "Bell" }, transport(), baseUrl),
    ).rejects.toMatchObject({
      message: "Failed to generate sound effect: 502 temporarily unavailable",
      status: 502,
      body: "temporarily unavailable",
    });
    expect(requests).toHaveLength(1);
  });

  it("keeps network errors without retry or legacy fallback", async () => {
    const failed = new Transport({
      apiKey: "test-key",
      fetch: localFetch,
      coreBaseUrl: "http://non-local.invalid",
    });
    await expect(
      speech.createSoundEffect({ text: "Bell" }, failed),
    ).rejects.toThrow("Speech test attempted a non-local request");
    expect(requests).toEqual([]);
  });

  it("rejects missing credentials before HTTP", async () => {
    delete process.env.SAPIOM_API_KEY;
    await expect(
      speech.listVoices(new Transport({ fetch: localFetch }), baseUrl),
    ).rejects.toThrow(/no tenant credential/i);
    expect(requests).toEqual([]);
  });
});
