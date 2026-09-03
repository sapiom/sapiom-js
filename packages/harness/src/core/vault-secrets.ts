/**
 * vault-secrets — the deployed half of an agent's credentials, read and written
 * on the Sapiom CORE surface.
 *
 * Same auth contract as account-plan.ts and template-catalog.ts, and verified
 * there: core takes `Authorization: Bearer`, NOT the agents surface's
 * `x-sapiom-api-key`, and every path is prefixed `/v1`. The key is held
 * server-side and never reaches the browser.
 *
 * THE ASYMMETRY THIS MODULE EXISTS TO PRESERVE. `GET .../secrets` returns
 * `{ keys: string[] }` — names, never values. There is no read path for a
 * stored value anywhere in the platform, deliberately. So this client can tell
 * you a credential IS set and never what it is, and nothing downstream should
 * be built expecting otherwise.
 *
 * READS DEGRADE, WRITES DO NOT. A failed read returns null and the tab says it
 * could not list; a failed write throws {@link VaultSecretError} and the user
 * is told which key did not land. A write that fails quietly is the one
 * outcome this surface must never produce — the user would believe a
 * credential is in place and find out during a production run.
 */

import {
  type ApiKeyProvider,
  staticApiKeyProvider,
} from "./api-key-provider.js";
import { resolveCoreBaseUrl } from "./definition-slug-resolver.js";

/** Mirrors account-plan.ts: statuses worth one refresh + retry. */
function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** A write that did not land, carrying enough to tell the user what to do. */
export class VaultSecretError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never completed. */
    readonly status: number,
  ) {
    super(message);
    this.name = "VaultSecretError";
  }
}

export interface VaultSecretsClient {
  /**
   * The credential NAMES configured on this definition, sorted. `null` means
   * the list could not be read (signed out, unreachable, drifted shape) — which
   * is different from `[]`, an agent that genuinely has none, and the tab says
   * something different for each.
   */
  list(definitionId: string): Promise<string[] | null>;
  /** Writes one value, replacing any existing one under the same name. */
  set(definitionId: string, key: string, value: string): Promise<void>;
  /** Removes one name. */
  remove(definitionId: string, key: string): Promise<void>;
}

export function createVaultSecretsClient(opts: {
  /** Accepts a provider (preferred — enables refresh-on-401) or a bare key. */
  apiKey: string | null | ApiKeyProvider;
  /** Override the core base URL (resolved from env by default). Test seam. */
  baseUrl?: string;
  /** Injectable fetch. Test seam. */
  fetchImpl?: typeof fetch;
}): VaultSecretsClient {
  const provider: ApiKeyProvider =
    opts.apiKey !== null && typeof opts.apiKey === "object"
      ? opts.apiKey
      : staticApiKeyProvider(opts.apiKey);
  const baseUrl = opts.baseUrl ?? resolveCoreBaseUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const secretsPath = (definitionId: string): string =>
    `/v1/workflows/definitions/${encodeURIComponent(definitionId)}/secrets`;

  /**
   * One request with the held key, retried once against a refreshed key when
   * the first is rejected — the same recovery account-plan.ts and runs.ts use.
   * Returns null only when there is no key at all or the transport threw.
   */
  const send = async (
    path: string,
    init: RequestInit,
  ): Promise<Response | null> => {
    const apiKey = provider.getKey();
    if (!apiKey) return null;

    const attempt = async (key: string): Promise<Response | null> => {
      try {
        return await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers: {
            ...init.headers,
            // Core (`api.*`) takes a Bearer token — see template-catalog.ts.
            Authorization: `Bearer ${key}`,
          },
        });
      } catch {
        return null;
      }
    };

    const response = await attempt(apiKey);
    if (!response || !isAuthRejection(response.status)) return response;

    const refreshed = await provider.refresh();
    if (!refreshed || refreshed === apiKey) return response;
    return await attempt(refreshed);
  };

  /**
   * Turn a non-OK write into an error the user can act on. The response body is
   * NEVER echoed verbatim: these routes take a credential in the request, and
   * an upstream that reflected part of it back would put it in a toast.
   */
  const refuse = (response: Response | null, key: string): VaultSecretError => {
    if (!response) {
      return new VaultSecretError(
        `${key} could not be sent to Sapiom. Check the harness is signed in and can reach the API.`,
        0,
      );
    }
    if (isAuthRejection(response.status)) {
      return new VaultSecretError(
        `${key} was rejected: the harness is not authorized to write this agent's secrets. Sign in again, or check the key has write access.`,
        response.status,
      );
    }
    if (response.status === 404) {
      return new VaultSecretError(
        `${key} could not be stored: this agent was not found on Sapiom.`,
        404,
      );
    }
    return new VaultSecretError(
      `${key} could not be stored (HTTP ${response.status}).`,
      response.status,
    );
  };

  return {
    async list(definitionId) {
      const response = await send(secretsPath(definitionId), { method: "GET" });
      if (!response || !response.ok) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      // `{ keys: string[] }`, narrowed rather than trusted: this endpoint is
      // outside core's public OpenAPI surface, so its shape is a contract by
      // observation. Anything else reads as "could not list".
      const keys = (body as { keys?: unknown } | null)?.keys;
      if (!Array.isArray(keys)) return null;
      return keys.filter((k): k is string => typeof k === "string").sort();
    },

    async set(definitionId, key, value) {
      const response = await send(secretsPath(definitionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, secret: value }),
      });
      // 204 is the documented success. Accept any 2xx so a future 200 does not
      // read as a failure, but nothing else.
      if (!response || !response.ok) throw refuse(response, key);
    },

    async remove(definitionId, key) {
      const response = await send(
        `${secretsPath(definitionId)}/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      );
      // DELETE is idempotent here, so a 404 is success. Note what the status
      // does NOT tell us: this route answers 404 both for a key the vault does
      // not hold and for a definition it cannot find (`refuse` reads the same
      // status as the latter), so a delete against a stale `definitionId`
      // reports success too. That is the right trade anyway — after either
      // one, the credential is not stored under the name the caller asked
      // about — and the alternative is worse: treating 404 as a failure made a
      // locally-held key on a LINKED agent undeletable, because the vault 404s
      // a name it was never given, the route refused, and the local copy
      // stayed. That is reachable by adding a secret before linking, which is
      // the ordinary path rather than an edge one.
      if (response?.status === 404) return;
      if (!response || !response.ok) throw refuse(response, key);
    },
  };
}
