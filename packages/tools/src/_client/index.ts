/**
 * Auth + transport core for `@sapiom/tools` — the private "runtime half" every
 * capability namespace wraps. Capability modules call THIS; they never import each
 * other's runtime, so the cross-capability mesh (`repo.pushFromSandbox(sandbox)`)
 * has no package/module cycles. See docs/plans/capability-authoring-sdk.md.
 *
 * The credential resolves from one of two sources, same surface either way:
 *   - explicit:  createClient({ apiKey })  — standalone / open-source use
 *   - ambient:   SAPIOM_API_KEY (env), which the workflow engine injects per
 *                execution so step authors write zero auth plumbing.
 *
 * Attribution (which agent / trace a call belongs to) is execution context the
 * runtime owns, NOT a parameter of any operation — so it lives here on the
 * transport, set once and injected on every request, never threaded through
 * capability methods. The engine sets it per execution by constructing the
 * per-execution client; `withAttribution(...)` is a quiet escape hatch for the
 * router / standalone cases. Capability method signatures deliberately have no
 * attribution argument: that absence keeps LLM-authored step code from setting
 * (and getting wrong) context it doesn't own.
 *
 * Being the single HTTP choke point also makes this the (one) instrumentation
 * seam: every call enqueues a `capability.call` usage event — synchronously,
 * never awaited, live by default. See `./analytics.ts`.
 *
 * It is also where the credential's channel is enforced: https, or plain http
 * to loopback only, and never across a redirect to another origin. See
 * `./credential-policy.ts`.
 */
import {
  CAPABILITY_CALL_EVENT,
  analyticsFor,
  capabilityCallData,
  type AnalyticsHolder,
} from "./analytics.js";
import {
  assertCredentialMayTravel,
  fetchKeepingCredential,
  resolveCredentialPolicy,
  type CredentialPolicy,
} from "./credential-policy.js";
import { capabilityOf, ensureOk, markSapiomCall } from "./sapiom-call.js";
import { VERSION } from "../_generated/version.js";
import { TransportHttpError } from "./errors.js";

/**
 * Client marker stamped on EVERY request so the gateway can tell SDK traffic
 * from raw HTTP (drop-in provider SDK / curl). The gateway bins this to
 * `client:sdk` on its /v2 routing metrics; the exact value carries the version
 * for logs. Survives the edge→gateway hop (not in the edge strip-list).
 */
const CLIENT_MARKER = `sapiom-tools/${VERSION}`;

/**
 * Per-request attribution recorded with the gateway transaction. Every field is
 * optional and maps 1:1 to an `x-sapiom-*` header the collapsed flow understands.
 */
export interface Attribution {
  /**
   * @deprecated A free-form agent label, not a resolved agent. Prefer omitting — the agent a call
   * belongs to is resolved from the authenticated request.
   */
  agentName?: string;
  /**
   * @deprecated A free-form agent id (a label, not the resolved agent). Prefer omitting.
   */
  agentId?: string;
  /** Core trace id to link this call's transaction to — must reference an existing Core trace. */
  traceId?: string;
  /**
   * Activity trace this call's span nests under (the customer-facing execution trace). A distinct,
   * client-minted id — kept separate from `traceId` (the Core transaction trace) so the two never
   * collide on one header.
   */
  activityTraceId?: string;
  /** Parent span id this call nests under, within `activityTraceId`. */
  parentSpanId?: string;
  /** Id of the run/execution this call belongs to. */
  executionId?: string;
  /** Ordinal of the step this call was made from (0-based). */
  stepOrder?: number;
  /**
   * @deprecated Legacy correlation field. Use `traceId`.
   */
  traceExternalId?: string;
  /** Arbitrary JSON object stored with the transaction. Must be an object. */
  metadata?: Record<string, unknown>;
}

export interface TransportConfig {
  /** Explicit tenant API key. Omit inside an agent step — the engine injects it ambiently. */
  apiKey?: string;
  /** Inject a fetch (tests / non-standard runtimes). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Default attribution applied to every request this transport makes (see class doc). */
  attribution?: Attribution;
  /**
   * Opaque per-execution workflow resume token. Forwarded as the
   * `x-sapiom-workflow-token` header on a coding launch so the gateway can resume
   * the paused step. The SANDBOX runtime injects it ambiently
   * (`SAPIOM_CAPABILITY_RESUME_TOKEN`) and this is left unset; the IN-PROCESS
   * runtime — which must not touch process-global env — passes it explicitly here.
   * When omitted, falls back to the env var, so both runtimes work.
   */
  resumeToken?: string;
  /**
   * Allow plain `http://` to a non-loopback host, for a trusted private network
   * only (a Docker or CI service name). When unset, on iff
   * `SAPIOM_ALLOW_INSECURE_HTTP=1`; otherwise https, or plain http to loopback.
   */
  allowInsecureHttp?: boolean;
}

/**
 * Which header carries the tenant credential. Sapiom has two authenticated
 * surfaces with different conventions: most operations send `x-sapiom-api-key`
 * (the default), while a few send `x-api-key`. A capability that targets the
 * latter passes `authHeader: "x-api-key"`; everything else uses the default.
 * The credential value is the same — the Transport holds it; callers never do.
 */
export type AuthHeader = "x-sapiom-api-key" | "x-api-key";

const DEFAULT_AUTH_HEADER: AuthHeader = "x-sapiom-api-key";

/** Per-request options the Transport understands, layered over a normal `RequestInit`. */
export interface TransportRequestOptions {
  /**
   * Which header carries the tenant credential. Defaults to `x-sapiom-api-key`.
   * A capability sets this only when its destination expects a different header.
   */
  authHeader?: AuthHeader;
}

/**
 * Did `fetch` reject because the connection never happened?
 *
 * Structural on `name` rather than `instanceof TypeError`: this package is
 * bundled into agent artifacts and is handed an injected `fetch`, so the error
 * can be minted in another realm, where `instanceof` against our own globals is
 * false and the fact would silently never be recorded. Same reason
 * `readSapiomCall` recognizes the marker structurally.
 *
 * A `TypeError` alone is not enough: `fetch` uses one for every deterministic
 * request-construction failure too (a GET with a body, an invalid method, an
 * abort whose reason happens to be a TypeError). Those carry no `cause`, while a
 * connection that never happened always hangs the underlying socket error there.
 * Requiring a cause keeps a deterministic mistake out of the transient bucket,
 * and erring the other way is safe: a rejection without one records no fact and
 * simply behaves as it did before this contract existed.
 */
function isNetworkRejection(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TypeError" &&
    (error as { cause?: unknown }).cause !== undefined
  );
}

/**
 * Raise a malformed URL or header before the call instead of letting `fetch`
 * reject with the same `TypeError` it uses for a dead connection. The two
 * constructors run the very validation `fetch` runs internally, so this cannot
 * reject a request that would otherwise have gone out.
 *
 * Not everything is separable: an unsupported scheme surfaces as a plain
 * `fetch failed` with a cause, identical to a transport failure. The base URL is
 * platform-controlled, so that case does not arise from a step body.
 */
function assertRequestable(
  url: string,
  headers: ConstructorParameters<typeof Headers>[0],
): void {
  new URL(url);
  new Headers(headers);
}

function attributionToHeaders(a: Attribution): Record<string, string> {
  const h: Record<string, string> = {};
  if (a.agentName) h["x-sapiom-agent-name"] = a.agentName;
  if (a.agentId) h["x-sapiom-agent-id"] = a.agentId;
  if (a.traceId) h["x-sapiom-trace-id"] = a.traceId;
  if (a.activityTraceId) h["x-sapiom-activity-trace-id"] = a.activityTraceId;
  if (a.parentSpanId) h["x-sapiom-parent-span-id"] = a.parentSpanId;
  if (a.executionId) h["x-sapiom-execution-id"] = a.executionId;
  // 0 is a valid first-step ordinal — guard on undefined, not falsiness.
  if (a.stepOrder !== undefined) h["x-sapiom-step-order"] = String(a.stepOrder);
  if (a.traceExternalId) h["x-sapiom-trace-external-id"] = a.traceExternalId;
  if (a.metadata) h["x-sapiom-metadata"] = JSON.stringify(a.metadata);
  return h;
}

/**
 * Standalone-only ambient attribution. Read once for the process-global default
 * transport. NOT the engine's injection channel — `process.env` is process-wide,
 * so it would bleed across step executions that share a worker. The engine sets
 * attribution by constructing the per-execution client instead. Safe only for the
 * one-execution-per-process case (CLI, scripts).
 */
export function attributionFromEnv(): Attribution {
  const a: Attribution = {};
  if (process.env.SAPIOM_AGENT_ID) a.agentId = process.env.SAPIOM_AGENT_ID;
  if (process.env.SAPIOM_AGENT_NAME)
    a.agentName = process.env.SAPIOM_AGENT_NAME;
  if (process.env.SAPIOM_TRACE_ID) a.traceId = process.env.SAPIOM_TRACE_ID;
  if (process.env.SAPIOM_ACTIVITY_TRACE_ID)
    a.activityTraceId = process.env.SAPIOM_ACTIVITY_TRACE_ID;
  if (process.env.SAPIOM_PARENT_SPAN_ID)
    a.parentSpanId = process.env.SAPIOM_PARENT_SPAN_ID;
  if (process.env.SAPIOM_EXECUTION_ID)
    a.executionId = process.env.SAPIOM_EXECUTION_ID;
  if (process.env.SAPIOM_STEP_ORDER) {
    const n = Number(process.env.SAPIOM_STEP_ORDER);
    if (Number.isFinite(n)) a.stepOrder = n;
  }
  if (process.env.SAPIOM_TRACE_EXTERNAL_ID)
    a.traceExternalId = process.env.SAPIOM_TRACE_EXTERNAL_ID;
  return a;
}

export class Transport {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly attribution: Attribution;
  /**
   * The workflow resume token to forward (see {@link TransportConfig.resumeToken}).
   * Explicit config wins; otherwise the ambient env var, so the sandbox runtime —
   * which injects `SAPIOM_CAPABILITY_RESUME_TOKEN` — keeps working unchanged.
   */
  readonly resumeToken: string | undefined;
  private readonly policy: CredentialPolicy;
  /**
   * Lazily-created usage-analytics emitter (see `./analytics.ts`). Not readonly:
   * `withAttribution` re-points the derived transport at ITS holder so one client
   * keeps one emitter no matter how many attributed views are derived from it.
   */
  private analyticsHolder: AnalyticsHolder = {};

  constructor(config: TransportConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.SAPIOM_API_KEY ?? undefined;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.attribution = config.attribution ?? {};
    this.resumeToken =
      config.resumeToken ??
      process.env.SAPIOM_CAPABILITY_RESUME_TOKEN ??
      undefined;
    this.policy = resolveCredentialPolicy(config.allowInsecureHttp);
  }

  /**
   * A new transport sharing this one's credential, fetch, and resume token, with
   * `attribution` merged over the current defaults. The escape hatch for the cases
   * where one process attributes to many agents/traces (a router) — not something
   * step-authoring code reaches for.
   */
  withAttribution(attribution: Attribution): Transport {
    const derived = new Transport({
      apiKey: this.apiKey,
      fetch: this.fetchImpl,
      attribution: { ...this.attribution, ...attribution },
      resumeToken: this.resumeToken,
      allowInsecureHttp: this.policy.allowInsecureHttp,
    });
    derived.analyticsHolder = this.analyticsHolder;
    return derived;
  }

  /**
   * Flush and shut down this client's usage-analytics emitter: buffered events
   * are delivered best-effort and the emitter's `beforeExit` hook is detached.
   * Resolves immediately when no emitter was ever created (no calls made, or
   * analytics disabled); idempotent; never rejects. One call covers every
   * transport derived via {@link withAttribution} (they share the emitter).
   *
   * Call this once per client in hosts that construct MANY clients in one
   * process — e.g. an engine worker building a per-execution client — so exit
   * hooks don't accumulate across executions. One-shot processes don't need
   * it: the emitter flushes on process exit by itself. Capability calls made
   * after shutdown still work; they just no longer emit analytics.
   */
  async shutdown(): Promise<void> {
    await this.analyticsHolder.instance?.shutdown();
  }

  /**
   * Authenticated raw fetch — capabilities that need streaming or custom
   * response handling (filesystem, log streams) use this and inspect the
   * `Response` themselves. Injects the tenant credential + attribution headers;
   * sets no content-type.
   *
   * The credential rides `x-sapiom-api-key` by default; pass
   * `{ authHeader: "x-api-key" }` for a destination that expects that header
   * instead (the value is identical — the Transport owns the key either way).
   */
  async fetch(
    url: string,
    init: RequestInit = {},
    options: TransportRequestOptions = {},
  ): Promise<Response> {
    if (!this.apiKey) {
      throw new Error(
        "@sapiom/tools: no tenant credential. Pass createClient({ apiKey }) for standalone use, " +
          "or run inside a Sapiom agent run (the engine injects SAPIOM_API_KEY).",
      );
    }
    // Everything that can fail while BUILDING the request happens before the try:
    // refusing an unsafe channel for the credential, serializing caller metadata
    // (circular, BigInt), parsing the URL, validating the headers. `fetch`
    // rejects with a bare TypeError for all of those AND for a connection that
    // never happened, with nothing on the error to tell them apart, so raising
    // them here is the only way to keep a deterministic local failure out of the
    // transient bucket. Marking one transient would buy the caller three
    // attempts at something that cannot succeed.
    assertCredentialMayTravel(new URL(url), this.policy);
    const headers: Record<string, string> = {
      [options.authHeader ?? DEFAULT_AUTH_HEADER]: this.apiKey,
      "x-sapiom-client": CLIENT_MARKER,
      ...attributionToHeaders(this.attribution),
      // Merged as a plain object, as before: callers pass records.
      ...(init.headers as Record<string, string> | undefined),
    };
    assertRequestable(url, headers);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchKeepingCredential(
        this.fetchImpl,
        url,
        init,
        headers,
        this.policy,
      );
    } catch (error) {
      this.trackCapabilityCall(url, init, startedAt, undefined, error);
      // No response ever existed, so there is no status to record. An aborted
      // signal means the caller stopped waiting on purpose, whatever shape the
      // rejection took.
      if (init.signal?.aborted !== true && isNetworkRejection(error)) {
        markSapiomCall(error, { network: true, capability: capabilityOf(url) });
      }
      throw error;
    }
    this.trackCapabilityCall(url, init, startedAt, response);
    return response;
  }

  /**
   * Enqueue ONE `capability.call` usage event for a finished (or failed) HTTP
   * call. Synchronous — nothing on the call path is awaited — and never throws;
   * a silent no-op unless a collector endpoint is configured (see `./analytics.ts`).
   * `request()` funnels through `fetch()`, so every capability call is counted
   * exactly once.
   */
  private trackCapabilityCall(
    url: string,
    init: RequestInit,
    startedAt: number,
    response?: Response,
    error?: unknown,
  ): void {
    try {
      analyticsFor(this.analyticsHolder, this.apiKey).track(
        CAPABILITY_CALL_EVENT,
        capabilityCallData({
          url,
          method: init.method,
          requestBody: init.body,
          durationMs: Date.now() - startedAt,
          status: response?.status,
          ok: response?.ok ?? false,
          error,
          attribution: this.attribution,
        }),
      );
    } catch {
      // Usage analytics must never affect a capability call.
    }
  }

  /**
   * Authenticated JSON request — parses the body and throws on a non-2xx status.
   * The throw is a {@link TransportHttpError} carrying the status and parsed
   * body, so a capability can classify the rejection (see `agents.run`).
   */
  async request<T>(
    url: string,
    init: RequestInit = {},
    options: TransportRequestOptions = {},
  ): Promise<T> {
    const res = await this.fetch(
      url,
      {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      },
      options,
    );
    // Through the shared non-2xx path so the call's facts are recorded here like
    // everywhere else, but still throwing `TransportHttpError`: `agents` branches
    // on that class. The `→` separator stands in for the `<prefix>: <status>`
    // form the capability namespaces use, so the factory formats the message
    // rather than taking the default, and it stays byte-identical.
    await ensureOk(
      res,
      `${init.method ?? "GET"} ${url} →`,
      ({ errorPrefix, status, body, text }) =>
        new TransportHttpError({
          message: `${errorPrefix} ${status} ${text}`,
          status,
          method: init.method ?? "GET",
          url,
          body,
        }),
      capabilityOf(url),
    );
    return (await res.json()) as T;
  }
}

/** The ambient default transport used by barrel-imported capabilities when no client is supplied. */
let _default: Transport | undefined;
export function defaultTransport(): Transport {
  return (_default ??= new Transport({ attribution: attributionFromEnv() }));
}

export {
  capabilityCall,
  resolveCoreBaseUrl,
  type CapabilityCallOptions,
} from "./capability-call.js";

export { TransportHttpError } from "./errors.js";

export {
  SAPIOM_CALL_MARKER_KEY,
  SapiomCallError,
  capabilityOf,
  ensureOk,
  failIfNotOk,
  markSapiomCall,
  parseRetryAfter,
  readSapiomCall,
  type SapiomCallErrorFactory,
  type SapiomCallFactsInput,
  type SapiomCallFailure,
  type SapiomCallMarker,
} from "./sapiom-call.js";
