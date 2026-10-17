import {
  CredentialChannelError,
  credentialFetch,
  mayCarryCredential,
  resolveCredentialPolicy,
  type Credential,
  type CredentialPolicy,
} from "./credential.js";
import type { DebugHook, Envelope, FetchLike } from "./types.js";

/**
 * The hosted Sapiom collector URL (see CONTRACT.md).
 *
 * This is the emitter's DEFAULT endpoint: an emitter with no explicit
 * `endpoint` configured delivers here (see {@link resolveEndpoint}).
 * Turning analytics off is a consent decision (`disabled: true`,
 * `SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`), not an endpoint one.
 */
export const SAPIOM_COLLECTOR_ENDPOINT =
  "https://api.sapiom.ai/v1/analytics/collector";

/** Environment override of the endpoint (used by tests). */
const ENDPOINT_ENV_VAR = "SAPIOM_ANALYTICS_ENDPOINT";

/** Bound every request so a hung collector can never wedge a flush. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * What the queue should do with a batch:
 * - `ok`    — delivered
 * - `retry` — transient failure (network error, 429, 5xx); one retry allowed
 * - `drop`  — permanent failure (4xx, unserializable); retrying cannot help
 */
export type SendOutcome = "ok" | "retry" | "drop";

/**
 * Endpoint resolution: explicit config → environment override → hosted
 * default ({@link SAPIOM_COLLECTOR_ENDPOINT}).
 *
 * Empty strings are treated as absent rather than as endpoints, so an
 * explicit `endpoint: ""` falls through to the environment override and
 * then to the hosted default. Resolution always yields an endpoint;
 * disabling delivery is consent's job (see `consent.ts`), never this
 * function's.
 */
export function resolveEndpoint(configEndpoint?: string): string {
  if (typeof configEndpoint === "string" && configEndpoint.length > 0) {
    return configEndpoint;
  }
  const fromEnv = process.env[ENDPOINT_ENV_VAR];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  // LIVE DEFAULT: the hosted collector is deployed, so an unconfigured
  // emitter delivers there.
  return SAPIOM_COLLECTOR_ENDPOINT;
}

export interface HttpSenderOptions {
  endpoint: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  debug: DebugHook;
  timeoutMs?: number;
}

/**
 * POSTs `{ events: [...] }` to the collector with native `fetch`.
 * Never rejects — every failure maps to a {@link SendOutcome}.
 */
export class HttpSender {
  private readonly policy: CredentialPolicy;

  constructor(private readonly options: HttpSenderOptions) {
    this.policy = resolveCredentialPolicy(undefined, {
      label: "@sapiom/analytics-core",
    });
  }

  async send(events: Envelope[]): Promise<SendOutcome> {
    try {
      const fetchImpl = this.resolveFetch();
      if (!fetchImpl) return "drop";

      let body: string;
      try {
        body = JSON.stringify({ events });
      } catch (error) {
        this.options.debug("batch not serializable; dropped", error);
        return "drop";
      }

      const response = await credentialFetch(
        // Only `{ ok, status }` is read, and `credentialFetch` tolerates a
        // response that has nothing more.
        fetchImpl as unknown as typeof fetch,
        this.options.endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: createTimeoutSignal(
            this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
          ),
        },
        this.credentialFor(this.options.endpoint),
        this.policy,
      );
      if (response.ok) return "ok";
      if (response.status === 429 || response.status >= 500) return "retry";
      // Anything else (400 not-JSON, 413 too large, …): retrying cannot help.
      return "drop";
    } catch (error) {
      if (error instanceof CredentialChannelError) {
        // A redirect to a channel the key may not use: resending lands there again.
        this.options.debug("collector redirect refused; batch dropped", error);
        return "drop";
      }
      this.options.debug("collector request failed", error);
      return "retry";
    }
  }

  /**
   * Analytics never fails the host over its channel: on an endpoint the key
   * may not use, the batch still goes out, anonymous.
   */
  private credentialFor(endpoint: string): Credential | undefined {
    const { apiKey } = this.options;
    if (!apiKey) return undefined;
    const url = new URL(endpoint);
    if (mayCarryCredential(url, this.policy)) {
      return { header: "x-sapiom-api-key", value: apiKey };
    }
    this.options.debug(
      "endpoint is not https or loopback; batch sent without the API key",
      url.origin,
    );
    return undefined;
  }

  private resolveFetch(): FetchLike | null {
    if (this.options.fetchImpl) return this.options.fetchImpl;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    return typeof globalFetch === "function" ? globalFetch : null;
  }
}

/** `AbortSignal.timeout` where available; its timer never holds the process open. */
function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  try {
    const signalCtor = (
      globalThis as {
        AbortSignal?: { timeout?: (ms: number) => AbortSignal };
      }
    ).AbortSignal;
    if (signalCtor && typeof signalCtor.timeout === "function") {
      return signalCtor.timeout(timeoutMs);
    }
  } catch {
    // Optional capability.
  }
  return undefined;
}
