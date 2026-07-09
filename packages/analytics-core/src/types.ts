/**
 * Public types for `@sapiom/analytics-core`.
 */

/** Where an event was produced. */
export type EventSource =
  | "ui"
  | "mcp"
  | "tools"
  | "cli"
  | "agent"
  | "langchain"
  | "backend";

/** Minimal response shape the sender needs — structurally satisfied by `Response`. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
}

/** Request options the sender passes to `fetch` (or an injected replacement). */
export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/**
 * Minimal fetch signature used to deliver batches. The global `fetch`
 * satisfies it; tests can inject a fake.
 */
export type FetchLike = (
  url: string,
  init: FetchRequestInit,
) => Promise<FetchResponseLike>;

/**
 * Optional hook for observing internal failures. Analytics never logs on its
 * own; without this hook every internal error is silently swallowed.
 */
export type DebugHook = (message: string, detail?: unknown) => void;

export interface AnalyticsConfig {
  /** Which surface is emitting (e.g. `"cli"`, `"tools"`). */
  source: EventSource;
  /** Emitting package name, e.g. `"@sapiom/tools"`. */
  sdkName: string;
  /** Emitting package version. */
  sdkVersion: string;
  /**
   * Collector URL. Defaults to the hosted Sapiom collector (the exported
   * `SAPIOM_COLLECTOR_ENDPOINT` constant). An empty string is treated as
   * absent and falls through to the default. To turn analytics off, use an
   * opt-out (`disabled`, `SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`)
   * rather than the endpoint.
   */
  endpoint?: string;
  /** Optional API key, sent as `x-sapiom-api-key` for server-side enrichment. */
  apiKey?: string;
  /** Signed-in account identity. Only set when a real user identity is known. */
  userId?: string;
  /** Programmatic opt-out. Highest-precedence consent signal. */
  disabled?: boolean;
  /**
   * Optional consent hook, consulted after the environment opt-outs.
   * Return `true` or `false` to decide; return `undefined` (or throw) to
   * fall through to the default (enabled).
   */
  consentProvider?: () => boolean | undefined;
  /** Custom fetch implementation (dependency injection, primarily for tests). */
  fetchImpl?: FetchLike;
  /** See {@link DebugHook}. */
  debug?: DebugHook;
}

/**
 * The event envelope sent to the collector. Field names are wire-format
 * (snake_case) by design.
 */
export interface Envelope {
  /** uuid4, client-generated; the collector's dedup key. */
  event_id: string;
  /** Machine-scoped uuid4 persisted in the identity file; `null` when unavailable. */
  anonymous_id: string | null;
  /** uuid4 shared by every event from this process. */
  session_id: string;
  /** ISO-8601, client clock. */
  event_timestamp: string;
  source: EventSource;
  event_type: string;
  /** Present only when a signed-in identity is known. Never synthesized. */
  user_id?: string;
  sdk_name: string;
  sdk_version: string;
  schema_version: string;
  environment?: string;
  data: Record<string, unknown>;
}

/** Envelope fields that `track()` overrides may replace per event. */
export type EnvelopeFields = Omit<Envelope, "data">;

export interface SapiomAnalytics {
  /**
   * Enqueue one event. Synchronous, never throws, never blocks; a no-op
   * when consent is denied or the instance has been shut down.
   */
  track(
    eventType: string,
    data?: Record<string, unknown>,
    overrides?: Partial<EnvelopeFields>,
  ): void;
  /** Send everything buffered. Best-effort; never rejects. */
  flush(): Promise<void>;
  /** `flush()` + stop timers and exit hooks. Never rejects. */
  shutdown(): Promise<void>;
  /**
   * `true` only when events can actually be emitted: consent resolved to
   * enabled (and initialization succeeded). The `false` causes are
   * intentionally merged; callers that need to distinguish the opt-outs
   * should inspect `SAPIOM_TELEMETRY_DISABLED` / `DO_NOT_TRACK` themselves.
   */
  readonly enabled: boolean;
  /** Persisted anonymous machine id, or `null` when disabled/unavailable. */
  readonly anonymousId: string | null;
  /** Per-process session uuid4. */
  readonly sessionId: string;
}
