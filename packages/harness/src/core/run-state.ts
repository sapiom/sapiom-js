/**
 * run-state — fetches a prod execution projection from the agents surface and
 * renders it to a {@link RunView} the canvas can poll.
 *
 * WHY the agents surface: deployed agent runs are owned by the agents runtime
 * (`GET /agents/v1/executions/:id`), not the core-capabilities surface. The
 * response is the full ExecutionProjection JSON (same shape agent-core's
 * decodeExecutionProjection consumes).
 *
 * WHY the key stays server-side: the Sapiom API key is a harness credential that
 * must never reach the browser. The harness server fetches on behalf of the
 * canvas, so the SPA polls a local `/api/runs/:id/state` endpoint (no key in the
 * request) rather than calling the upstream surface directly.
 *
 * NOTE: this env-precedence helper for the agents base URL is duplicated
 * elsewhere in the harness; consolidate into one shared helper when convenient.
 */

import { decodeExecutionProjection } from "@sapiom/agent-core";

import type { RunView } from "../shared/types.js";
import { resolveCoreBaseUrl } from "./definition-slug-resolver.js";
import { renderRunState } from "./render-run-state.js";
import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "./api-key-provider.js";

/**
 * Normalize the polymorphic `apiKey` option to an {@link ApiKeyProvider}. A
 * plain string (or null) becomes a no-refresh provider so existing static-key
 * callers keep working unchanged; a provider is used as-is.
 */
function toApiKeyProvider(
  apiKey: string | null | ApiKeyProvider,
): ApiKeyProvider {
  if (apiKey === null || typeof apiKey === "string") {
    return staticApiKeyProvider(apiKey);
  }
  return apiKey;
}

/** Resolve the agents surface base URL from the environment. */
export function resolveAgentsBaseUrl(): string {
  return (
    process.env.SAPIOM_AGENTS_URL ??
    process.env.SAPIOM_TOOLS_BASE ??
    "https://tools.sapiom.ai"
  );
}

export type RunStateResult =
  | { ok: true; runView: RunView }
  | { ok: false; status: number; error: string };

export interface RunStateFetcherOpts {
  /**
   * Sapiom API key. Accepts either a plain `string | null` (the boot-time key)
   * or an {@link ApiKeyProvider} — pass a provider to get the refresh-on-401
   * recovery path. A bare string never refreshes.
   */
  apiKey: string | null | ApiKeyProvider;
  baseUrl?: string;
  /** Override Core's base URL (resolved from env by default). Test seam. */
  coreBaseUrl?: string;
  /** Injectable fetch implementation — defaults to global fetch. Test seam. */
  fetchImpl?: typeof fetch;
}

export interface RunStateFetcher {
  fetch(executionId: string): Promise<RunStateResult>;
}

/**
 * Core's own view of the same execution, used when the agents surface 404s.
 *
 * A 404 from the gateway is ambiguous in a way that matters: it means either
 * "no such execution" or "no such ROUTE". On a local stack it is the latter —
 * `GET /agents/v1/executions/:id` is not mounted there, so a cloud run that
 * completed fine reported "execution not found" and Studio could never show its
 * status. Asking Core resolves the ambiguity: if Core has the execution it is
 * rendered, and if Core has not heard of it either then it genuinely does not
 * exist.
 *
 * Core returns the same projection shape, so the SAME decoder renders it —
 * verified against a real completed execution rather than assumed.
 *
 * Note the header: Core authenticates `x-api-key`; the gateway's
 * `x-sapiom-api-key` is rejected there with a 401.
 *
 * The gateway stays primary. It owns deployed agent runs in production, and
 * this is a fallback rather than a replacement so prod behaviour is unchanged.
 */
async function fetchFromCore(
  executionId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  coreBaseUrl: string,
): Promise<Response | null> {
  try {
    return await fetchImpl(
      `${coreBaseUrl}/v1/workflows/executions/${encodeURIComponent(executionId)}`,
      { headers: { "x-api-key": apiKey } },
    );
  } catch {
    // Core unreachable too — the caller keeps the gateway's verdict.
    return null;
  }
}

/** Upstream statuses that mean "the API key was rejected" — worth one refresh
 *  + retry before we give up. 401 is the common case; 403 covers a key that
 *  authenticated but lost authorization (e.g. rotated to a new org). */
export function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Create a fetcher that resolves an execution's current render state from the
 * agents surface. The fetcher is intentionally non-throwing: all error paths
 * return a typed {@link RunStateResult} with `ok: false` so the router can
 * forward the appropriate HTTP status without a try/catch at the call site.
 *
 * When constructed with an {@link ApiKeyProvider}, a 401/403 from the upstream
 * call triggers exactly one credential refresh + retry: if the shared store has
 * a newer key (e.g. the user re-logged-in), the retry uses it and the Studio
 * recovers in place instead of surfacing a dead-end auth error.
 */
export function createRunStateFetcher(
  opts: RunStateFetcherOpts,
): RunStateFetcher {
  const { baseUrl = resolveAgentsBaseUrl(), fetchImpl = fetch } = opts;
  // Resolved lazily: `resolveCoreBaseUrl()` reads the environment, and reading
  // it at construction would freeze whatever was set at boot.
  const coreBase = (): string => opts.coreBaseUrl ?? resolveCoreBaseUrl();
  const provider = toApiKeyProvider(opts.apiKey);

  const requestOnce = async (
    executionId: string,
    apiKey: string,
  ): Promise<
    { kind: "ok"; res: Response } | { kind: "err"; result: RunStateResult }
  > => {
    try {
      const res = await fetchImpl(
        `${baseUrl}/agents/v1/executions/${encodeURIComponent(executionId)}`,
        { headers: { "x-sapiom-api-key": apiKey } },
      );
      return { kind: "ok", res };
    } catch {
      return {
        kind: "err",
        result: { ok: false, status: 502, error: "gateway unreachable" },
      };
    }
  };

  const decode = async (
    res: Response,
    onNotFound?: () => Promise<RunStateResult>,
  ): Promise<RunStateResult> => {
    if (res.status === 404) {
      // Ask Core before declaring it missing — see fetchFromCore.
      if (onNotFound) return onNotFound();
      return { ok: false, status: 404, error: "execution not found" };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: 502,
        error: `gateway responded ${res.status}`,
      };
    }
    try {
      const raw = (await res.json()) as Record<string, unknown>;
      const runView = renderRunState(decodeExecutionProjection(raw));
      return { ok: true, runView };
    } catch {
      return { ok: false, status: 502, error: "could not decode execution" };
    }
  };

  /** Second opinion from Core, keeping the gateway's 404 if Core has none. */
  const viaCore = async (
    executionId: string,
    apiKey: string,
  ): Promise<RunStateResult> => {
    const res = await fetchFromCore(executionId, apiKey, fetchImpl, coreBase());
    if (!res || !res.ok) {
      return { ok: false, status: 404, error: "execution not found" };
    }
    try {
      const raw = (await res.json()) as Record<string, unknown>;
      return { ok: true, runView: renderRunState(decodeExecutionProjection(raw)) };
    } catch {
      return { ok: false, status: 502, error: "could not decode execution" };
    }
  };

  return {
    async fetch(executionId: string): Promise<RunStateResult> {
      // No API key — do not touch the network; the harness is not signed in.
      let apiKey = provider.getKey();
      if (!apiKey) {
        return {
          ok: false,
          status: 503,
          error: "harness is not signed in to Sapiom",
        };
      }

      const first = await requestOnce(executionId, apiKey);
      if (first.kind === "err") return first.result;

      // Refresh-on-401: re-read the shared credential store once and retry with
      // the newer key when the rejection was an auth failure and refresh
      // actually produced a different key. Any other status (or an unchanged
      // key) falls through to normal decoding/error mapping — no wasted retry.
      if (isAuthRejection(first.res.status)) {
        const refreshed = await provider.refresh();
        if (refreshed && refreshed !== apiKey) {
          apiKey = refreshed;
          const second = await requestOnce(executionId, apiKey);
          if (second.kind === "err") return second.result;
          return decode(second.res, () => viaCore(executionId, apiKey!));
        }
      }

      return decode(first.res, () => viaCore(executionId, apiKey));
    },
  };
}
