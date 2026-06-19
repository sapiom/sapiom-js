/**
 * Thin HTTP client for the Sapiom workflows gateway. Auth is a single
 * `x-sapiom-api-key` header (the gateway resolves the tenant from it); the key
 * comes from the environment so it never lands in a committed file.
 */
import { CliError } from './output.js';
import { readCredential } from './session.js';

const DEFAULT_HOST = 'https://workflows.services.sapiom.ai';

/** Host precedence: explicit env override → linked project's host → default. */
export function resolveHost(configHost?: string): string {
  return process.env.SAPIOM_WORKFLOWS_HOST ?? configHost ?? DEFAULT_HOST;
}

/**
 * Credential precedence: the environment always wins (CI / ephemeral /
 * agents), then the stored session from `sapiom login`. Stateful by default,
 * but every stateful path has a stateless override.
 */
function resolveApiKey(): string {
  const env = process.env.SAPIOM_API_KEY;
  if (env) return env;

  const stored = readCredential();
  const token = stored?.accessToken ?? stored?.apiKey;
  if (token) return token;

  throw new CliError({
    code: 'NO_CREDENTIAL',
    message: 'Not authenticated.',
    hint: 'Run: sapiom login  (or set SAPIOM_API_KEY).',
  });
}

export class GatewayClient {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(host?: string) {
    this.base = `${resolveHost(host).replace(/\/$/, '')}/v1/workflows`;
    this.apiKey = resolveApiKey();
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'x-sapiom-api-key': this.apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new CliError({
        code: 'NETWORK',
        message: `Could not reach ${this.base}.`,
        hint: err instanceof Error ? err.message : String(err),
      });
    }

    const text = await res.text();
    const data = text ? safeParse(text) : undefined;
    if (!res.ok) {
      throw new CliError({
        code: `HTTP_${res.status}`,
        message: messageFrom(data) ?? `Request failed (${res.status} ${res.statusText}).`,
        hint:
          res.status === 401 || res.status === 403
            ? 'Re-run `sapiom login` (or check SAPIOM_API_KEY) and that it has access to this orchestration.'
            : undefined,
      });
    }
    return data as T;
  }

  get<T = any>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
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
    const m = (data as { message?: unknown }).message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string') return m;
  }
  return undefined;
}
