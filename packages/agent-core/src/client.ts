/**
 * Configurable HTTP client for the Sapiom workflows backend API. All inputs are
 * passed explicitly (base URL + API key) — no process.env reads, no global
 * state — so the client is usable from a CLI, an MCP tool, or a test harness.
 */
import { AgentOperationError } from './errors.js';

/**
 * Production host for the Sapiom backend tenant API.
 * The `/v1/workflows` path is appended internally for every method except
 * `postAtHostRoot`, which addresses the host root directly.
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
 *
 * Its identity is host + credential. `/v1/workflows` is the base almost every
 * route shares, not the whole of what this client can address — see
 * {@link postAtHostRoot}.
 */
export class GatewayClient {
  /**
   * API host root, no trailing slash. The primary field — {@link base} is
   * derived from it. Kept because a few tenant-API routes are not workflow
   * resources and sit at the root (see {@link postAtHostRoot}).
   */
  private readonly host: string;
  /** `${host}/v1/workflows` — what get/post/request/openStream paths are relative to. */
  private readonly base: string;
  private readonly apiKey: string;

  constructor(opts: ClientOptions) {
    this.host = stripTrailingSlashes(opts.host ?? DEFAULT_WORKFLOWS_HOST);
    this.base = `${this.host}/v1/workflows`;
    this.apiKey = opts.apiKey;
  }

  /** `path` is relative to `/v1/workflows`. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, `${this.base}${path}`, body);
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /**
   * POST to a path rooted at the API HOST instead of the `/v1/workflows` base.
   * `path` must be the full route including its version segment
   * (e.g. `/v1/studio-feedback`).
   *
   * Most of the tenant API lives under `/v1/workflows`, so that prefix is baked
   * into {@link base}. A few routes are not workflow resources but reach the
   * same host with the same `x-api-key` — keeping them on this client keeps
   * them on the one AgentOperationError mapping, rather than a bare `fetch`
   * that re-implements it. A separate method rather than a special path prefix
   * on {@link request}: which base a path is relative to must be declared by
   * the call site, never inferred from how the path is spelled.
   *
   * POST-only on purpose — add sibling verbs when a route actually needs one.
   */
  postAtHostRoot<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', `${this.host}${path}`, body);
  }

  /**
   * POST raw bytes as `application/gzip` — the source-archive upload
   * (AGENT-289). `path` is relative to `/v1/workflows`.
   *
   * Routed through {@link send} rather than a bare `fetch` so it inherits the one
   * NETWORK / HTTP_* / 401-hint mapping. A separate method rather than a flag on
   * {@link post}: a caller must state that it is sending an opaque body, never
   * have it inferred from the value's runtime type.
   *
   * The shared request timeout applies unchanged: a source archive measures in
   * kilobytes, so this is still a short round-trip.
   */
  postArchive<T = unknown>(path: string, archive: Uint8Array): Promise<T> {
    return this.send<T>('POST', `${this.base}${path}`, archive, 'application/gzip');
  }

  /**
   * The single JSON request path — every method above funnels here so the
   * NETWORK / HTTP_* / 401-hint mapping is defined exactly once.
   *
   * Bounded by {@link REQUEST_TIMEOUT_MS}: without a signal, a blackholed
   * connection rides undici's defaults (headers timeout ~5 minutes), and the
   * caller is often an MCP tool handler — the agent then just "hangs" with no
   * message, which is exactly how this surfaced on a Windows machine that
   * couldn't reach the gateway. Every request through here is a short
   * JSON round-trip (long operations poll with repeated requests — see
   * deploy.ts's pollBuild — and streams go through openStream, which is
   * deliberately NOT bounded this way), so one generous cap fits all.
   */
  private async send<T>(
    method: string,
    url: string,
    body?: unknown,
    /** Non-JSON media type; the body is then sent verbatim rather than stringified. */
    contentType = 'application/json',
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'x-api-key': this.apiKey, 'content-type': contentType },
        body:
          body === undefined
            ? undefined
            : contentType === 'application/json'
              ? JSON.stringify(body)
              : (body as Uint8Array),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(url, err);
    }

    // The body read is inside the same timeout as the request, so a stalled
    // or reset body rejects HERE with a raw TimeoutError/TypeError — map it
    // through the same NETWORK error the fetch above gets, or callers that
    // switch on `code`/`hint` see an opaque "operation was aborted".
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw networkError(url, err);
    }
    const data = text ? safeParse(text) : undefined;
    if (!res.ok) {
      throw new AgentOperationError({
        code: `HTTP_${res.status}`,
        message: messageFrom(data) ?? `Request failed (${res.status} ${res.statusText}).`,
        hint:
          res.status === 401 || res.status === 403
            ? 'Check your API key (`sapiom login` or SAPIOM_API_KEY) and that it has access to this agent.'
            : undefined,
      });
    }
    return data as T;
  }

  /**
   * Open a Server-Sent Events stream and return the raw {@link Response} so the
   * caller can read `body` as it arrives (see `watchExecution`). Auth is the same
   * `x-api-key` presented on every request — the engine sits behind the
   * service-key proxy, so the SDK just presents its key. Handshake failures map
   * to the same `AgentOperationError` shape as {@link request} (never a bare
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

    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers, signal: opts.signal });
    } catch (err) {
      throw networkError(url, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const data = text ? safeParse(text) : undefined;
      throw new AgentOperationError({
        code: `HTTP_${res.status}`,
        message: messageFrom(data) ?? `Stream request failed (${res.status} ${res.statusText}).`,
        hint:
          res.status === 401 || res.status === 403
            ? 'Check your API key (`sapiom login` or SAPIOM_API_KEY) and that it has access to this agent.'
            : undefined,
      });
    }
    if (!res.body) {
      throw new AgentOperationError({
        code: 'NETWORK',
        message: `Stream at ${url} returned no body.`,
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

/**
 * Normalize a host by dropping every trailing slash — a hand-edited credentials
 * file or a proxy config ending in `//` would otherwise produce `host//v1/...`,
 * which many routers treat as a distinct (404ing) path.
 *
 * Deliberately not a regex. The obvious `/\/+$/` backtracks quadratically on a
 * host with many interior slashes (`a` + `/`.repeat(n) + `b`), and the host is
 * caller-supplied; this scan is linear and allocates once.
 */
function stripTrailingSlashes(host: string): string {
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return end === host.length ? host : host.slice(0, end);
}

/** See {@link GatewayClient.send} — per-request ceiling for one JSON round-trip. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Unreachable-host failure, shaped identically wherever a fetch rejects. */
function networkError(url: string, err: unknown): AgentOperationError {
  // AbortSignal.timeout rejects with TimeoutError — name the duration and the
  // likely cause rather than surfacing an opaque "operation was aborted".
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new AgentOperationError({
      code: 'NETWORK',
      message: `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
      hint: 'Is this machine able to reach the Sapiom API (firewall/proxy)? Try again once connectivity is confirmed.',
    });
  }
  return new AgentOperationError({
    code: 'NETWORK',
    message: `Could not reach ${url}.`,
    hint: err instanceof Error ? err.message : String(err),
  });
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
