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
import { capabilityCall } from "../_client/capability-call.js";
import { SpeechHttpError } from "./errors.js";

export { SpeechHttpError };

/**
 * Rachel's provider voice ID.
 * @deprecated Core owns the default voice. Omit `voice` to use it. This export
 * will be removed in a future release.
 */
export const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

const speechError = (message: string, status: number, body: unknown): Error =>
  new SpeechHttpError(message, status, body);

// ----- Types -----

export interface SpeechCreateInput {
  /** The text to convert to speech (required, must be non-empty). */
  text: string;
  /**
   * Provider voice ID to use. Core selects the default when omitted.
   * Call `voices.list()` to select an ID. Voice names are not resolved.
   */
  voice?: string;
  /**
   * Optional Core model ID, such as `eleven_flash_v2_5`. It sets the price class,
   * takes precedence over `params.model_id`, and Core rejects unsupported models
   * before billing. Core uses its default when both are absent.
   */
  model?: string;
  /**
   * Optional: persist the generated audio to Sapiom file storage. When set, the
   * result carries `fileId` (or `storageError` if persisting failed).
   */
  storage?: { visibility?: "private" | "public" };
  /**
   * Optional Core idempotency key. Reusing a key returns its first successful
   * result, so use a new key per request; a failed request can retry with it.
   */
  idempotencyKey?: string;
  /** Advanced: provider options sent to Core under `params`; Core validates them. */
  params?: Record<string, unknown>;
}

export interface SoundEffectInput {
  /** The text prompt describing the sound effect to generate (required, must be non-empty). */
  text: string;
  /**
   * Optional Core model ID, such as `eleven_text_to_sound_v2`. It sets the
   * price class, takes precedence over `params.model_id`, and Core rejects
   * unsupported models before billing. Core uses its default when both are absent.
   */
  model?: string;
  /**
   * Optional duration in seconds. Overrides `params.duration_seconds`; null or
   * omitted defers to it, and Core picks a duration when both are absent.
   */
  durationSeconds?: number | null;
  /**
   * Optional: persist the generated audio to Sapiom file storage. When set, the
   * result carries `fileId` (or `storageError` if persisting failed).
   */
  storage?: { visibility?: "private" | "public" };
  /**
   * Optional Core idempotency key. Reusing a key returns its first successful
   * result, so use a new key per request; a failed request can retry with it.
   */
  idempotencyKey?: string;
  /** Advanced: provider options sent to Core under `params`; Core validates them. */
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
  /** Every available voice, across all pages. */
  voices: Voice[];
}

// ----- Internal response shapes -----

interface RawVoicesResponse {
  voices?: Voice[];
  /** Core's opaque cursor, present only when more voices remain. */
  nextCursor?: unknown;
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
  baseUrl?: string,
): Promise<SpeechResult> {
  assertText(input.text);
  return capabilityCall<SpeechResult>(
    "speech.tts",
    {
      text: input.text,
      voice: input.voice,
      model: input.model,
      storage: input.storage,
      params: input.params,
      idempotencyKey: input.idempotencyKey,
    },
    {
      transport,
      baseUrl,
      makeError: speechError,
      errorPrefix: "Failed to generate speech",
    },
  );
}

/**
 * Generate a sound effect from a text prompt. Pass `storage` to persist the
 * output (the result then carries `fileId`). Failed requests throw
 * {@link SpeechHttpError}.
 */
export async function createSoundEffect(
  input: SoundEffectInput,
  transport: Transport = defaultTransport(),
  baseUrl?: string,
): Promise<SpeechResult> {
  assertText(input.text);
  return capabilityCall<SpeechResult>(
    "speech.sound-effects",
    {
      text: input.text,
      model: input.model,
      durationSeconds: input.durationSeconds,
      storage: input.storage,
      params: input.params,
      idempotencyKey: input.idempotencyKey,
    },
    {
      transport,
      baseUrl,
      makeError: speechError,
      errorPrefix: "Failed to generate sound effect",
    },
  );
}

/**
 * List every available voice. Pass a `voiceId` to `textToSpeech.create({ voice })`.
 * Follows Core's `nextCursor` until no pages remain; Core sets the page size. A
 * failed page or a repeated cursor throws {@link SpeechHttpError} rather than
 * returning a partial list.
 */
export async function listVoices(
  transport: Transport = defaultTransport(),
  baseUrl?: string,
): Promise<VoicesResult> {
  const options = {
    transport,
    baseUrl,
    makeError: speechError,
    errorPrefix: "Failed to list voices",
  };
  const voices: Voice[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await capabilityCall<RawVoicesResponse>(
      "speech.voices.list",
      { cursor },
      options,
    );
    voices.push(...(page.voices ?? []));
    const next = page.nextCursor;
    if (typeof next !== "string" || !next) return { voices };
    // A repeated cursor would page forever.
    if (seen.has(next)) {
      throw new SpeechHttpError(
        "Failed to list voices: Core returned a repeated cursor",
        502,
        { error: "repeated_cursor", cursor: next },
      );
    }
    seen.add(next);
    cursor = next;
  }
}

// ----- Namespace exports -----

/** Text-to-speech operations. */
export const textToSpeech = { create: createSpeech };

/** Sound effect generation. */
export const soundEffects = { create: createSoundEffect };

/** Voice listing. */
export const voices = { list: listVoices };
