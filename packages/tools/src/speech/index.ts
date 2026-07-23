/**
 * `speech` capability — text-to-speech, sound effects, and voice listing.
 * The same speech tools your agents call over MCP, callable directly from code.
 *
 *   import { speech } from "@sapiom/tools";              // ambient auth
 *   const result = await speech.textToSpeech.create({ text: "Hello world" });
 *   result.url;        // hosted audio URL
 *   result.fileId;     // present when `storage` was passed → use with fileStorage
 *
 *   const sfx = await speech.soundEffects.create({ text: "thunder clap" });
 *   const { voices } = await speech.voices.list();
 *
 * Or via an explicit client: `createClient({ apiKey }).speech.textToSpeech.create(...)`.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, SpeechHttpError } from "./errors.js";

export { SpeechHttpError };

const DEFAULT_BASE_URL = resolveServiceUrl("elevenlabs", process.env.SAPIOM_SPEECH_URL);

/** Default voice used when none is specified. */
export const DEFAULT_VOICE = "Rachel";

// ----- Types -----

export interface SpeechCreateInput {
  /** The text to convert to speech (required, must be non-empty). */
  text: string;
  /**
   * Voice name or id to use. Defaults to a standard voice when omitted.
   * Call `voices.list()` to see available voices.
   */
  voice?: string;
  /**
   * Optional: persist the generated audio to Sapiom file storage. When set, the
   * result carries `fileId` (or `storageError` if persisting failed).
   */
  storage?: { visibility?: "private" | "public" };
  /** Advanced: extra parameters forwarded verbatim to the underlying model. */
  params?: Record<string, unknown>;
}

export interface SoundEffectInput {
  /** The text prompt describing the sound effect to generate (required, must be non-empty). */
  text: string;
  /**
   * Optional duration in seconds for the generated sound effect.
   */
  durationSeconds?: number;
  /**
   * Optional: persist the generated audio to Sapiom file storage. When set, the
   * result carries `fileId` (or `storageError` if persisting failed).
   */
  storage?: { visibility?: "private" | "public" };
  /** Advanced: extra parameters forwarded verbatim to the underlying model. */
  params?: Record<string, unknown>;
}

export interface SpeechResult {
  /**
   * Hosted URL of the generated audio. May be short-lived; when you requested
   * `storage`, prefer `fileId` for a durable reference.
   */
  url?: string;
  /** ISO-8601 timestamp when `url` expires, when applicable. */
  expiresAt?: string;
  /**
   * Present when `storage` was requested and the output was persisted. The durable
   * reference — re-fetch a fresh download URL any time via
   * `fileStorage.getDownloadUrl(fileId)`.
   */
  fileId?: string;
  /**
   * Present when `storage` was requested but persisting the output failed.
   */
  storageError?: string;
  /** Additional fields returned by the capability, passed through as-is. */
  [k: string]: unknown;
}

export interface Voice {
  /** Unique voice identifier. */
  voiceId: string;
  /** Human-readable voice name. */
  name?: string;
  /** Additional voice metadata returned by the capability. */
  [k: string]: unknown;
}

export interface VoicesResult {
  /** Available voices. */
  voices: Voice[];
  /** Additional fields returned by the capability. */
  [k: string]: unknown;
}

// ----- Internal response shapes -----

interface RawSpeechResponse {
  url?: string;
  expiresAt?: string;
  file_id?: string;
  storage_error?: string;
  [k: string]: unknown;
}

interface RawVoice {
  voice_id?: string;
  voiceId?: string;
  name?: string;
  [k: string]: unknown;
}

interface RawVoicesResponse {
  voices?: RawVoice[];
  [k: string]: unknown;
}

function mapSpeechResult(raw: RawSpeechResponse): SpeechResult {
  const { url, expiresAt, file_id, storage_error, ...rest } = raw;
  return {
    ...(url !== undefined && { url }),
    ...(expiresAt !== undefined && { expiresAt }),
    ...(file_id !== undefined && { fileId: file_id }),
    ...(storage_error !== undefined && { storageError: storage_error }),
    ...rest,
  };
}

function mapVoice(raw: RawVoice): Voice {
  const { voice_id, voiceId, name, ...rest } = raw;
  return {
    voiceId: voiceId ?? voice_id ?? "", // benign fallback — `voice` is optional at call sites
    ...(name !== undefined && { name }),
    ...rest,
  };
}

// ----- Guard -----

function assertText(text: unknown): void {
  if (typeof text !== "string" || text.trim() === "") {
    throw new SpeechHttpError(
      "text is required and must be a non-empty string",
      400,
      { error: "invalid_text" },
    );
  }
}

// ----- Capability operations -----

/**
 * Generate speech audio from text. Pass `storage` to persist the output to
 * Sapiom file storage (the result then carries `fileId`). Failed requests throw
 * {@link SpeechHttpError}.
 */
export async function createSpeech(
  input: SpeechCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SpeechResult> {
  assertText(input.text);

  const voice = input.voice ?? DEFAULT_VOICE;
  // `params` is spread first so it can't override the guard-validated `text` (or `storage`).
  const body: Record<string, unknown> = {
    ...input.params,
    text: input.text,
    ...(input.storage ? { storage: input.storage } : {}),
  };

  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voice)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      },
    ),
    "Failed to generate speech",
  );
  return mapSpeechResult((await res.json()) as RawSpeechResponse);
}

/**
 * Generate a sound effect from a text prompt. Pass `storage` to persist the
 * output (the result then carries `fileId`). Failed requests throw
 * {@link SpeechHttpError}.
 */
export async function createSoundEffect(
  input: SoundEffectInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SpeechResult> {
  assertText(input.text);

  // `params` is spread first so it can't override the guard-validated `text` (or duration/storage).
  const body: Record<string, unknown> = {
    ...input.params,
    text: input.text,
    ...(input.durationSeconds != null
      ? { duration_seconds: input.durationSeconds }
      : {}),
    ...(input.storage ? { storage: input.storage } : {}),
  };

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/sound-generation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    }),
    "Failed to generate sound effect",
  );
  return mapSpeechResult((await res.json()) as RawSpeechResponse);
}

/**
 * List available voices. Returns the set of voices you can pass to
 * `textToSpeech.create({ voice })`. Failed requests throw {@link SpeechHttpError}.
 */
export async function listVoices(
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<VoicesResult> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v2/voices`),
    "Failed to list voices",
  );
  const raw = (await res.json()) as RawVoicesResponse;
  const { voices: rawVoices, ...rest } = raw;
  return {
    voices: (rawVoices ?? []).map(mapVoice),
    ...rest,
  };
}

// ----- Namespace exports -----

/** Text-to-speech operations. */
export const textToSpeech = { create: createSpeech };

/** Sound effect generation. */
export const soundEffects = { create: createSoundEffect };

/** Voice listing. */
export const voices = { list: listVoices };
