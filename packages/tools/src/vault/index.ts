/**
 * READ-ONLY access to tenant vault secrets (SAP-1471).
 *
 *   import { vault } from "@sapiom/tools";              // ambient auth
 *   const keys = await vault.list("my-service-creds");  // key names only
 *   const value = await vault.get("my-service-creds", "API_KEY"); // string | null
 *   const all = await vault.getAll("my-service-creds"); // full key→value map
 *
 * Or via an explicit client: `createClient({ apiKey }).vault.get(...)`.
 *
 * Read/list only BY DECISION — no set/delete: giving an LLM agent write access to a
 * secret store is a separate, deliberate risk decision. Write secrets from the
 * dashboard or the low-level `@sapiom/core` `VaultAPI`.
 *
 * Wire: the vault gateway's v2 API ONLY (`/v2/secrets/:ref[/:key]`, GSM-backed).
 * v1 is a separate legacy store that silently returns `{}` with HTTP 200 — never
 * call it. Values are credentials: use them, don't persist or echo them.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, VaultHttpError } from "./errors.js";

export { VaultHttpError };

/**
 * Vault service ORIGIN. Resolves like every other @sapiom/tools capability: an
 * explicit `SAPIOM_VAULT_URL` override wins, else the `SAPIOM_SERVICES_BASE` knob
 * re-homes it (subdomain preserved), else the production
 * `https://vault.services.sapiom.ai`. This is the bare origin; the `/v2/secrets`
 * path prefix is appended per-method below.
 */
const DEFAULT_BASE_URL = resolveServiceUrl(
  "vault",
  process.env.SAPIOM_VAULT_URL,
);

/** The gateway's single-secret response shape (`GET /v2/secrets/:ref/:key`). */
interface VaultSecretResponse {
  value: string | null;
}

/** Build the `/v2/secrets/:ref` URL, optionally narrowed to a `keys=` subset. */
function secretsUrl(baseUrl: string, ref: string, keys?: string[]): string {
  const path = `${baseUrl}/v2/secrets/${encodeURIComponent(ref)}`;
  if (keys === undefined) return path;
  const params = new URLSearchParams();
  params.set("keys", keys.join(","));
  return `${path}?${params.toString()}`;
}

// ----- capability operations (read-only) -----

/**
 * Get all secrets stored under a ref as a flat key→value map. Handle the values
 * as credentials — use them, never persist or echo them.
 */
export async function getAll(
  ref: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Record<string, string>> {
  const res = await ensureOk(
    await transport.fetch(secretsUrl(baseUrl, ref)),
    `Failed to get vault secrets for ref '${ref}'`,
  );
  return (await res.json()) as Record<string, string>;
}

/**
 * Get a subset of secrets stored under a ref. Passing an empty keys array sends
 * `keys=` and returns the API's empty subset.
 */
export async function getMany(
  ref: string,
  keys: string[],
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Record<string, string>> {
  const res = await ensureOk(
    await transport.fetch(secretsUrl(baseUrl, ref, keys)),
    `Failed to get vault secrets for ref '${ref}'`,
  );
  return (await res.json()) as Record<string, string>;
}

/**
 * Get one secret value by ref and key. Returns `null` when the key (or ref) is
 * absent — a missing credential is an expected lookup outcome, not an error.
 */
export async function get(
  ref: string,
  key: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<string | null> {
  const url = `${baseUrl}/v2/secrets/${encodeURIComponent(ref)}/${encodeURIComponent(key)}`;
  try {
    const res = await ensureOk(
      await transport.fetch(url),
      `Failed to get vault secret '${key}' for ref '${ref}'`,
    );
    const body = (await res.json()) as VaultSecretResponse;
    return body.value;
  } catch (error) {
    if (error instanceof VaultHttpError && error.status === 404) return null;
    throw error;
  }
}

/**
 * List the secret KEY NAMES stored under a ref (sorted). The gateway's v2 API has
 * no names-only endpoint, so this fetches the map and returns only its keys — use
 * it when you need to discover what exists without spreading values through your
 * code.
 */
export async function list(
  ref: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<string[]> {
  const all = await getAll(ref, transport, baseUrl);
  return Object.keys(all).sort();
}
