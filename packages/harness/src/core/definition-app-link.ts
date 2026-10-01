/**
 * definition-app-link — the durable App Link bound to a cloud definition, read
 * from the Sapiom CORE surface for the session bar's running-app slot
 * (SAP-3255).
 *
 * `GET /v1/workflows/definitions/:id/app-link` → `{ url, status }` (SAP-3633).
 * Core withholds the URL until a bundle is published, so `"live"` means there
 * is something to open, not that a sandbox is awake: an App Link sleeps when
 * idle and starts on demand. Nothing here claims availability.
 *
 * Same auth contract as account-plan.ts and vault-secrets.ts: core takes
 * `Authorization: Bearer`, every path is prefixed `/v1`, and a 401/403 gets
 * exactly one credential refresh + retry. The key stays server-side.
 *
 * READS DEGRADE. Every failure (signed out, unreachable, 404, drifted shape, a
 * URL that is not `https:`) reads as `{ url: null, status: null }`, which the
 * slot renders as nothing — exactly the bar an agent without an App Link gets.
 * A broken dashboard read must never take the session bar down.
 */

import type { DefinitionAppLinkView } from "../shared/types.js";
import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "./api-key-provider.js";
import { resolveCoreBaseUrl } from "./definition-slug-resolver.js";

/** Mirrors account-plan.ts: statuses worth one refresh + retry. */
function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** Matches definition-slug-resolver.ts's per-read deadline. */
const READ_TIMEOUT_MS = 5_000;

export const NO_APP_LINK: DefinitionAppLinkView = { url: null, status: null };

export interface DefinitionAppLinkReader {
  /** Never throws; see the module header for what degrades to `NO_APP_LINK`. */
  read(definitionId: string): Promise<DefinitionAppLinkView>;
}

/**
 * Narrow core's body to the view. The URL becomes an `href` in the browser, so
 * only a well-formed `https:` URL survives; a `live` status without one is not
 * something the slot can open, and reads as nothing.
 */
export function extractDefinitionAppLink(body: unknown): DefinitionAppLinkView {
  if (typeof body !== "object" || body === null) return NO_APP_LINK;
  const { url, status } = body as { url?: unknown; status?: unknown };
  if (status === "unpublished") return { url: null, status: "unpublished" };
  if (status !== "live" || typeof url !== "string") return NO_APP_LINK;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NO_APP_LINK;
  }
  if (parsed.protocol !== "https:") return NO_APP_LINK;
  return { url: parsed.href, status: "live" };
}

export function createDefinitionAppLinkReader(opts: {
  /** Accepts a provider (preferred — enables refresh-on-401) or a bare key. */
  apiKey: string | null | ApiKeyProvider;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam. */
  fetchImpl?: typeof fetch;
  /** Per-read deadline. Test seam; defaults to {@link READ_TIMEOUT_MS}. */
  timeoutMs?: number;
}): DefinitionAppLinkReader {
  const provider: ApiKeyProvider =
    opts.apiKey !== null && typeof opts.apiKey === "object"
      ? opts.apiKey
      : staticApiKeyProvider(opts.apiKey);
  const baseUrl = opts.baseUrl ?? resolveCoreBaseUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;

  const attempt = async (
    path: string,
    key: string,
    signal: AbortSignal,
  ): Promise<Response | null> => {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        // Core (`api.*`) takes a Bearer token — see template-catalog.ts.
        headers: { Authorization: `Bearer ${key}` },
        signal,
      });
    } catch {
      return null;
    }
  };

  return {
    async read(definitionId) {
      const apiKey = provider.getKey();
      if (!apiKey) return NO_APP_LINK;
      const path = `/v1/workflows/definitions/${encodeURIComponent(definitionId)}/app-link`;
      // ONE deadline for the whole read, bounded like definition-slug-resolver.ts:
      // the chip is ambient, so a stalled core must not hold the page's request
      // open. Shared by both attempts and the body read, so a refresh + retry
      // cannot double the budget.
      const signal = AbortSignal.timeout(timeoutMs);

      let response = await attempt(path, apiKey, signal);
      if (response && isAuthRejection(response.status)) {
        // A local credential re-read, not a network call; the retry still
        // shares the deadline above.
        const refreshed = await provider.refresh();
        if (signal.aborted) return NO_APP_LINK;
        if (refreshed && refreshed !== apiKey) {
          response = await attempt(path, refreshed, signal);
        }
      }
      if (!response || !response.ok) return NO_APP_LINK;
      try {
        return extractDefinitionAppLink(await response.json());
      } catch {
        return NO_APP_LINK;
      }
    },
  };
}
