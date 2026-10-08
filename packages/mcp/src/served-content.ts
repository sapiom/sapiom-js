import type { ResolvedEnvironment } from "./credentials.js";

/**
 * The one fetch for served teaching text (SAP-3225): the MCP authoring primer
 * (`/v1/mcp/instructions`), the Agent Studio system prompt
 * (`/v1/harness/system-prompt`) and the platform authoring rules
 * (`/v1/agents/authoring-rules`) are all public, unauthenticated `GET`s that
 * carry the `X-Sapiom-Content-*` stamp headers (SAP-3190), and every caller
 * must survive the backend being down. Each caller layers its own fallback on
 * the `null` this returns: the primer its last-known-good cache and bundled
 * snapshot, the Studio prompt and the session skill their bundled copies, the
 * drift check silence.
 */

/** How long to wait for a served-content endpoint before giving up. */
export const SERVED_CONTENT_FETCH_TIMEOUT_MS = 5000;

export interface ServedContent {
  /**
   * The body as delivered, trimmed: serve-time footer included, never empty.
   * Empty when the fetch was `headersOnly`.
   */
  body: string;
  /** `X-Sapiom-Content-Release`, or `null` when the response is unstamped. */
  release: string | null;
  /** `X-Sapiom-Content-Digest`, or `null` when the response is unstamped. */
  digest: string | null;
  /** `X-Sapiom-Content-Key`, or `null` when absent. */
  key: string | null;
}

export interface FetchServedContentOptions {
  /** Endpoint path on the environment's API host, e.g. `/v1/agents/authoring-rules`. */
  path: string;
  /**
   * Name of an env var that, set to `1` or `true`, skips the request and
   * returns `null`: an escape hatch for an air-gapped run, and how a test
   * suite keeps a caller off the network.
   */
  disableEnv?: string;
  /**
   * Read only the stamp headers and release the connection without buffering
   * the body. For a caller that compares stamps and never uses the text.
   */
  headersOnly?: boolean;
}

/**
 * `true` when `disableEnv` names an env var set to `1` or `true` (any case,
 * surrounding whitespace ignored) — the spellings every Sapiom opt-out flag
 * accepts. A flag that ignored `=true` would stall an air-gapped session for
 * the full timeout, having been told not to fetch.
 */
export function servedContentFetchDisabled(disableEnv?: string): boolean {
  if (!disableEnv) return false;
  const value = process.env[disableEnv];
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/**
 * `GET {apiURL}{path}` with a {@link SERVED_CONTENT_FETCH_TIMEOUT_MS} timeout.
 * Never throws and never rejects: `null` on a disabled flag, a non-200, an
 * empty body, a network error or a timeout. The stamp headers are returned
 * as-is; a caller that needs the body to hash to them validates that itself
 * (`validateStampedBody`).
 */
export async function fetchServedContent(
  env: Pick<ResolvedEnvironment, "apiURL">,
  options: FetchServedContentOptions,
): Promise<ServedContent | null> {
  if (servedContentFetchDisabled(options.disableEnv)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVED_CONTENT_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${env.apiURL}${options.path}`, {
      headers: { Accept: "text/markdown, text/plain" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const stamp = {
      release: response.headers.get("x-sapiom-content-release"),
      digest: response.headers.get("x-sapiom-content-digest"),
      key: response.headers.get("x-sapiom-content-key"),
    };
    if (options.headersOnly) {
      await response.body?.cancel().catch(() => undefined);
      return { body: "", ...stamp };
    }
    const body = (await response.text()).trim();
    return body.length > 0 ? { body, ...stamp } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
