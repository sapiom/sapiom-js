/**
 * api-key-provider — the single source of truth for the Sapiom API key that
 * Studio actions authenticate with server-side.
 *
 * WHY this exists: the key is resolved ONCE at CLI boot (from the cached
 * credential or a fresh browser login) and then handed to the server as a plain
 * string. Two problems fell out of that snapshot:
 *
 *  1. It never refreshes. If the key is rotated/revoked — or the user runs the
 *     shared login again in another process, rewriting the credential store —
 *     the running Studio server keeps sending the stale key and every upstream
 *     call 401s until the whole server is restarted. There was no re-auth path.
 *  2. It conflated two different secrets. The per-boot *boot token*
 *     (`X-Harness-Token`) only gates the LOCAL `/api` surface; the *API key*
 *     (`sk_…`) is what authenticates upstream Sapiom calls. Studio actions must
 *     authenticate with the held API key, never the boot token.
 *
 * This provider holds the current key behind a getter (so consumers read the
 * live value, not a boot-time copy) and can `refresh()` it by re-reading the
 * shared credential store the CLI/MCP login writes to
 * (`~/.sapiom/credentials.json`, via `@sapiom/mcp/auth`). A 401 from an
 * upstream call can therefore recover in place — refresh, then retry — instead
 * of locking the Studio.
 *
 * NOT in scope (deliberately, per the ticket): triggering an interactive
 * browser re-login from the server, or a broader session-auth redesign. Refresh
 * here is a silent re-read of already-cached credentials; if the store has no
 * newer key, the call surfaces the auth error honestly.
 */

import { readCredentials, resolveEnvironment } from "@sapiom/mcp/auth";

/**
 * Reads the currently-held API key and can refresh it from the shared
 * credential store. Consumers should call {@link getKey} per request (never
 * cache the returned string across requests) and {@link refresh} exactly once
 * when an upstream call returns 401/403, retrying only if refresh yields a
 * different, non-null key.
 */
export interface ApiKeyProvider {
  /** The current API key, or null when the harness is not signed in. */
  getKey(): string | null;
  /**
   * Re-read the shared credential store and adopt any newer key found there.
   * Returns the (possibly updated) current key, or null if none is available.
   * Never throws — a read failure leaves the current key untouched and is
   * reported by returning the existing value.
   */
  refresh(): Promise<string | null>;
}

/** Overridable reads for the credential store — a test seam. Defaults hit the
 *  real `@sapiom/mcp/auth` store the CLI login writes to. */
export interface ApiKeyProviderDeps {
  /** Resolve the active environment name (governs which cached entry to read). */
  resolveEnvironmentName?: () => Promise<string>;
  /** Read the cached API key for a given environment, or null if absent. */
  readApiKeyForEnv?: (envName: string) => Promise<string | null>;
  /** Overrides SAPIOM_ENVIRONMENT for environment resolution. */
  environment?: string;
}

async function defaultResolveEnvironmentName(
  environment?: string,
): Promise<string> {
  const env = await resolveEnvironment(
    environment ?? process.env.SAPIOM_ENVIRONMENT,
  );
  return env.name;
}

async function defaultReadApiKeyForEnv(
  envName: string,
): Promise<string | null> {
  const entry = await readCredentials(envName);
  return entry?.apiKey ?? null;
}

/**
 * Build an {@link ApiKeyProvider} seeded with the boot-time key. `refresh()`
 * re-reads the shared credential store for the active environment and adopts a
 * newer key when one is present — the reconciliation point between the key the
 * CLI captured at boot and any key rotated/re-logged-in afterward.
 */
export function createApiKeyProvider(
  initialKey: string | null,
  deps: ApiKeyProviderDeps = {},
): ApiKeyProvider {
  let current = initialKey;
  const resolveEnvName =
    deps.resolveEnvironmentName ??
    (() => defaultResolveEnvironmentName(deps.environment));
  const readApiKey = deps.readApiKeyForEnv ?? defaultReadApiKeyForEnv;

  return {
    getKey(): string | null {
      return current;
    },
    async refresh(): Promise<string | null> {
      try {
        const envName = await resolveEnvName();
        const latest = await readApiKey(envName);
        // Only adopt a real, non-empty key. A missing/emptied credential must
        // not clobber a key that's simply been rotated out from under us but is
        // still the best value we have to report an honest auth error with.
        if (latest) current = latest;
      } catch {
        // Store unreadable (HOME missing, malformed file, …) — keep the current
        // key. The caller's retry will simply hit the same auth error, which is
        // the correct, honest outcome.
      }
      return current;
    },
  };
}

/**
 * Adapt a plain `string | null` API key into an {@link ApiKeyProvider} whose
 * `refresh()` is a no-op. Lets call sites that only ever have a static key
 * (tests, callers with no credential store) share the one provider-shaped
 * contract without special-casing.
 */
export function staticApiKeyProvider(key: string | null): ApiKeyProvider {
  return {
    getKey: () => key,
    refresh: () => Promise.resolve(key),
  };
}
