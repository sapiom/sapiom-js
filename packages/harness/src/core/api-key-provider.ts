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
 * here is a silent re-read of already-cached credentials. A confirmed absence
 * becomes signed out; a store failure preserves the last-known value.
 */

import { readCredentialsOrThrow, resolveEnvironment } from "@sapiom/mcp/auth";

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
   * Re-read the shared credential store. A successful read is authoritative;
   * a failed read preserves and returns the last-known key. Never throws.
   */
  refresh(): Promise<string | null>;
  /**
   * Unconditionally zero the in-memory key (sets it to null). Called on
   * disconnect so that {@link getKey} returns null immediately.
   */
  clear(): void;
}

/** Overridable reads for the credential store — a test seam. Defaults hit the
 *  real `@sapiom/mcp/auth` store the CLI login writes to. */
export interface ApiKeyProviderDeps {
  /** Resolve the active environment name (governs which cached entry to read). */
  resolveEnvironmentName?: () => Promise<string>;
  /** Strictly read the cached API key for an environment, or null if absent. */
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
  const entry = await readCredentialsOrThrow(envName);
  return entry?.apiKey ?? null;
}

/**
 * Build an {@link ApiKeyProvider} seeded with the boot-time key. `refresh()`
 * re-reads the shared credential store for the active environment and adopts
 * its current state — including a confirmed signed-out state. Store failures
 * preserve the last-known key.
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
  let refreshQueue: Promise<void> = Promise.resolve();

  const refreshFromStore = async (): Promise<string | null> => {
    try {
      const envName = await resolveEnvName();
      const latest = await readApiKey(envName);
      // A completed strict read is authoritative. Null/empty means the
      // credential was deliberately removed; only a thrown read preserves the
      // last-known key.
      current = latest?.trim() ? latest : null;
    } catch {
      // Store unreadable (permissions, malformed JSON, transient I/O) or an
      // invalid environment — preserve the last-known key.
    }
    return current;
  };

  return {
    getKey(): string | null {
      return current;
    },
    refresh(): Promise<string | null> {
      // Queue the whole resolve+read+adopt transaction. Without this, a slower
      // older refresh can finish after a newer one and restore stale state.
      const result = refreshQueue.then(refreshFromStore);
      refreshQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    clear(): void {
      current = null;
    },
  };
}

/**
 * Adapt a plain `string | null` API key into an {@link ApiKeyProvider} whose
 * `refresh()` is a no-op and `clear()` is a no-op. Lets call sites that only
 * ever have a static key (tests, callers with no credential store) share the
 * one provider-shaped contract without special-casing.
 */
export function staticApiKeyProvider(key: string | null): ApiKeyProvider {
  return {
    getKey: () => key,
    refresh: () => Promise.resolve(key),
    clear: () => {
      /* static key — clear is a no-op */
    },
  };
}
