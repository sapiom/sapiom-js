/**
 * `keys` capability — mint a durable, narrowly-scoped Sapiom API key from inside a
 * workflow step, so a long-lived artifact the step DEPLOYS can call Sapiom on every
 * future request with its own credential (SAP-2300).
 *
 *   import { keys } from "@sapiom/tools";                       // ambient auth
 *   const minted = await keys.mintScoped({ ttl: "30d" });      // scope defaults to
 *                                                              // metered-capability authority
 *   // inject minted.key into the deployed artifact's env as SAPIOM_API_KEY
 *
 * Or on the step context: `ctx.sapiom.keys.mintScoped({ ttl, scope })`.
 *
 * WHY this exists: the per-run capability token the engine injects as `SAPIOM_API_KEY`
 * EXPIRES with the step, so it cannot be handed to a child that outlives the run. And
 * the read-only `vault` deliberately cannot mint. `mintScoped` fills that gap through
 * the brokered scoped-key path: the Core endpoint mints a key attenuated to a SUBSET of
 * the run token's own permissions (never wildcard), attributed to the workflow
 * definition for lineage + billing, and ALWAYS expiring/revocable. It is minting-only —
 * there is no plaintext tenant key involved, and no way to widen authority beyond the
 * run's.
 *
 * The minted `key` is the plaintext secret, shown ONCE: inject it into the artifact's
 * environment and never persist or echo it.
 *
 * Wire: Core `POST /v1/api-keys/scoped/workflow`, the tenant credential on `x-api-key`
 * (the header the `/v1` controller guard reads — NOT the gateway-direct
 * `x-sapiom-api-key`). Only a workflow-run token may call it; any other principal 403s.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveCoreBaseUrl } from "../_client/capability-call.js";
import { ensureOk, KeysHttpError } from "./errors.js";

export { KeysHttpError };

/** How long a minted key lives before it expires. */
export interface MintScopedInput {
  /**
   * Lifetime of the minted key. A number is SECONDS; a string is a compact duration
   * (`"30d"`, `"12h"`, `"45m"`, `"3600s"`, or a bare number of seconds like `"3600"`).
   * Required — a workflow-minted key always expires. Clamped server-side to 60s..1 year.
   */
  ttl: number | string;
  /**
   * Permission scope(s) for the minted key — must be a subset of the calling token, and
   * never `"*"`. Omit to default to `"org.transactions.write"`, the authority every
   * metered Sapiom capability (models, database, sandboxes, search, …) needs. Pass a
   * narrower/different subset only when the artifact needs something specific.
   */
  scope?: string | string[];
}

/** A freshly minted scoped key. */
export interface ScopedKey {
  /**
   * The plaintext secret, shown ONCE. Inject it into your deployed artifact's
   * environment (e.g. `SAPIOM_API_KEY`); never persist, log, or echo it.
   */
  key: string;
  /** The minted key's id — use it to revoke the key later from the dashboard/API. */
  id: string;
  /** ISO-8601 expiry timestamp. The key always expires. */
  expiresAt: string | null;
  /** The permission keys the minted key carries. */
  permissions: string[];
}

/** The Core `CreateApiKeyResponseDto` shape (`{ apiKey, plainKey }`). */
interface MintResponse {
  apiKey: {
    id: string;
    expiresAt?: string | null;
    permissions?: string[] | null;
  };
  plainKey: string;
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
};

/**
 * Normalize `ttl` to whole seconds. Accepts a number (seconds) or a compact duration
 * string (`"30d"`, `"12h"`, `"45m"`, `"3600s"`, or a bare `"3600"`). Throws on an
 * unparseable or non-positive value — a bad TTL should fail loudly at the call site,
 * not silently mint a key with a surprising lifetime.
 */
export function toTtlSeconds(ttl: number | string): number {
  if (typeof ttl === "number") {
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new TypeError(
        `ttl must be a positive number of seconds, got ${ttl}`,
      );
    }
    return Math.floor(ttl);
  }
  const trimmed = ttl.trim();
  const match = /^(\d+)\s*([smhd]?)$/i.exec(trimmed);
  if (!match) {
    throw new TypeError(
      `ttl must be a number of seconds or a duration like "30d"/"12h"/"45m", got "${ttl}"`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase() || "s";
  const seconds = amount * DURATION_UNIT_SECONDS[unit];
  if (seconds <= 0) {
    throw new TypeError(
      `ttl must resolve to a positive number of seconds, got "${ttl}"`,
    );
  }
  return seconds;
}

/**
 * Mint a durable, narrowly-scoped Sapiom API key for an artifact the current workflow
 * step deploys. Returns the plaintext `key` (shown once) plus its id, expiry, and
 * permissions. Throws {@link KeysHttpError} on a non-2xx response (e.g. 403 when called
 * outside a workflow run or when the requested scope exceeds the run token).
 */
export async function mintScoped(
  input: MintScopedInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<ScopedKey> {
  const ttl = toTtlSeconds(input.ttl);
  const scope =
    input.scope === undefined
      ? undefined
      : Array.isArray(input.scope)
        ? input.scope
        : [input.scope];

  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/api-keys/scoped/workflow`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttl, ...(scope ? { scope } : {}) }),
      },
      { authHeader: "x-api-key" },
    ),
    "Failed to mint scoped key",
  );

  const body = (await res.json()) as MintResponse;
  return {
    key: body.plainKey,
    id: body.apiKey.id,
    expiresAt: body.apiKey.expiresAt ?? null,
    permissions: body.apiKey.permissions ?? [],
  };
}
