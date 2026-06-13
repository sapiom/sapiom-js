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
 */

export interface TransportConfig {
  /** Explicit tenant API key. Omit inside a workflow step — the engine injects it ambiently. */
  apiKey?: string;
  /** Inject a fetch (tests / non-standard runtimes). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export class Transport {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: TransportConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.SAPIOM_API_KEY ?? undefined;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  /**
   * Authenticated raw fetch — capabilities that need streaming or custom
   * response handling (filesystem, log streams) use this and inspect the
   * `Response` themselves. Injects the tenant credential; sets no content-type.
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
      headers: { "x-sapiom-api-key": this.apiKey, ...(init.headers ?? {}) },
    });
  }

  /** Authenticated JSON request — parses the body and throws on a non-2xx status. */
  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      throw new Error(`${init.method ?? "GET"} ${url} → ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}

/** The ambient default transport used by barrel-imported capabilities when no client is supplied. */
let _default: Transport | undefined;
export function defaultTransport(): Transport {
  return (_default ??= new Transport());
}
