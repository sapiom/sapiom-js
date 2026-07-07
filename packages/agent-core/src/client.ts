/**
 * Configurable HTTP client for the Sapiom workflows backend API. All inputs are
 * passed explicitly (base URL + API key) — no process.env reads, no global
 * state — so the client is usable from a CLI, an MCP tool, or a test harness.
 */
import { AgentOperationError } from './errors.js';

/**
 * Production host for the Sapiom backend tenant API.
 * The `/v1/workflows` path is appended internally.
 */
export const DEFAULT_WORKFLOWS_HOST = 'https://api.sapiom.ai';

export interface ClientOptions {
  /** Full host URL; defaults to the production backend host. */
  host?: string;
  /** API key sent as `x-api-key`. Must start with `sk_`. */
  apiKey: string;
}

/** Result shape from a failed gateway request. */
export interface GatewayErrorBody {
  message?: string | string[];
}

/**
 * A minimal, stateless HTTP client for the Sapiom workflows gateway. Construct
 * one per call-site with explicit credentials; pass it into networked core
 * functions rather than relying on environment look-ups.
 */
export class GatewayClient {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(opts: ClientOptions) {
    const host = (opts.host ?? DEFAULT_WORKFLOWS_HOST).replace(/\/$/, '');
    this.base = `${host}/v1/workflows`;
    this.apiKey = opts.apiKey;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new AgentOperationError({
        code: 'NETWORK',
        message: `Could not reach ${this.base}.`,
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    const text = await res.text();
    const data = text ? safeParse(text) : undefined;
    if (!res.ok) {
      throw new AgentOperationError({
        code: `HTTP_${res.status}`,
        message: messageFrom(data) ?? `Request failed (${res.status} ${res.statusText}).`,
        hint:
          res.status === 401 || res.status === 403
            ? 'Check your API key (`sapiom login` or SAPIOM_API_KEY) and that it has access to this orchestration.'
            : undefined,
      });
    }
    return data as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /**
   * Open a Server-Sent Events stream and return the raw {@link Response} so the
   * caller can read `body` as it arrives (see `watchExecution`). Auth is the same
   * `x-api-key` presented on every request — the engine sits behind the
   * service-key proxy, so the SDK just presents its key. Handshake failures map
   * to the same `OrchestrationError` shape as {@link request} (never a bare
   * fetch rejection or a non-ok Response the caller has to re-inspect).
   *
   * The body is NOT consumed here: on success the live stream is handed back
   * open. `signal` lets the caller abort the connection (iterator teardown);
   * `lastEventId` is forwarded as the resume cursor (`Last-Event-ID`).
   */
  async openStream(
    path: string,
    opts: { signal?: AbortSignal; lastEventId?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      accept: 'text/event-stream',
    };
    if (opts.lastEventId) {
      headers['last-event-id'] = opts.lastEventId;
    }

    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method: 'GET', headers, signal: opts.signal });
    } catch (err) {
      throw new OrchestrationError({
        code: 'NETWORK',
        message: `Could not reach ${this.base}.`,
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const data = text ? safeParse(text) : undefined;
      throw new OrchestrationError({
        code: `HTTP_${res.status}`,
        message: messageFrom(data) ?? `Stream request failed (${res.status} ${res.statusText}).`,
        hint:
          res.status === 401 || res.status === 403
            ? 'Check your API key (`sapiom login` or SAPIOM_API_KEY) and that it has access to this orchestration.'
            : undefined,
      });
    }
    if (!res.body) {
      throw new OrchestrationError({
        code: 'NETWORK',
        message: `Stream at ${this.base}${path} returned no body.`,
      });
    }
    return res;
  }
}

/**
 * Build a GatewayClient from explicit options. The factory is the recommended
 * entry point: it makes dependency injection obvious and keeps consumers
 * (CLI arg parse → factory → core fn) easy to read.
 */
export function createClient(opts: ClientOptions): GatewayClient {
  return new GatewayClient(opts);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageFrom(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'message' in data) {
    const m = (data as GatewayErrorBody).message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string') return m;
  }
  return undefined;
}
