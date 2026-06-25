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
 */

/**
 * Per-request attribution recorded with the gateway transaction. Every field is
 * optional and maps 1:1 to an `x-sapiom-*` header the collapsed flow understands.
 */
export interface Attribution {
  /** Human-readable agent name. Mutually exclusive with `agentId` (gateway-enforced). */
  agentName?: string;
  /** Agent UUID. Mutually exclusive with `agentName` (gateway-enforced). */
  agentId?: string;
  /** Sapiom trace id to attribute this call to. */
  traceId?: string;
  /** Your own external trace / correlation id. */
  traceExternalId?: string;
  /** Arbitrary JSON object stored with the transaction. Must be an object. */
  metadata?: Record<string, unknown>;
}

export interface TransportConfig {
  /** Explicit tenant API key. Omit inside a workflow step — the engine injects it ambiently. */
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
}

function attributionToHeaders(a: Attribution): Record<string, string> {
  const h: Record<string, string> = {};
  if (a.agentName) h["x-sapiom-agent-name"] = a.agentName;
  if (a.agentId) h["x-sapiom-agent-id"] = a.agentId;
  if (a.traceId) h["x-sapiom-trace-id"] = a.traceId;
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

  constructor(config: TransportConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.SAPIOM_API_KEY ?? undefined;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.attribution = config.attribution ?? {};
    this.resumeToken =
      config.resumeToken ?? process.env.SAPIOM_CAPABILITY_RESUME_TOKEN ?? undefined;
  }

  /**
   * A new transport sharing this one's credential, fetch, and resume token, with
   * `attribution` merged over the current defaults. The escape hatch for the cases
   * where one process attributes to many agents/traces (a router) — not something
   * step-authoring code reaches for.
   */
  withAttribution(attribution: Attribution): Transport {
    return new Transport({
      apiKey: this.apiKey,
      fetch: this.fetchImpl,
      attribution: { ...this.attribution, ...attribution },
      resumeToken: this.resumeToken,
    });
  }

  /**
   * Authenticated raw fetch — capabilities that need streaming or custom
   * response handling (filesystem, log streams) use this and inspect the
   * `Response` themselves. Injects the tenant credential + attribution headers;
   * sets no content-type.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.apiKey) {
      throw new Error(
        "@sapiom/tools: no tenant credential. Pass createClient({ apiKey }) for standalone use, " +
          "or run inside a Sapiom workflow (the engine injects SAPIOM_API_KEY).",
      );
    }
    return this.fetchImpl(url, {
      ...init,
      headers: {
        "x-sapiom-api-key": this.apiKey,
        ...attributionToHeaders(this.attribution),
        ...(init.headers ?? {}),
      },
    });
  }

  /** Authenticated JSON request — parses the body and throws on a non-2xx status. */
  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      throw new Error(
        `${init.method ?? "GET"} ${url} → ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }
}

/** The ambient default transport used by barrel-imported capabilities when no client is supplied. */
let _default: Transport | undefined;
export function defaultTransport(): Transport {
  return (_default ??= new Transport({ attribution: attributionFromEnv() }));
}
