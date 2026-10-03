/**
 * Per-agent secrets for `pnpm run setup`. The watchdog polls `GET /v1/workflows/executions`, which
 * needs `org.read`; the run's own key does not hold it, and nothing lets an agent ask for more. So
 * setup mints a child key with exactly `org.read` and stores it as the definition's secret, which
 * the engine injects into the agent's sandbox as an environment variable.
 *
 * The key value never leaves this module: it is not returned, logged or written to fleet-state.json.
 */
import { AgentOperationError, type GatewayClient } from "@sapiom/agent-core";

export const WATCHDOG_SECRET = "SYLON_WATCHDOG_API_KEY";
export const WATCHDOG_KEY_NAME = "sylon-watchdog (read runs)";
export const WATCHDOG_PERMISSIONS = ["org.read"];

type SecretsClient = Pick<GatewayClient, "get" | "post" | "postAtHostRoot">;

export interface ProvisionResult {
  /** `present`: the secret already existed and nothing changed. */
  outcome: "present" | "provisioned";
  /** The minted child key's id, when this run minted one. */
  keyId?: string;
}

/** Setup's caller lacks the permission to mint (or write) the key: say how to do it by hand. */
export class SecretProvisionError extends Error {
  constructor(detail: string) {
    super(
      `cannot provision ${WATCHDOG_SECRET} for the watchdog: ${detail}. ` +
        `The key running setup needs org.api_keys.write (to mint) and org.write (to set the secret). ` +
        `Or set it by hand: create an API key with only org.read, then add it as ${WATCHDOG_SECRET} ` +
        `in the sylon-watchdog agent's Secrets tab, and rerun setup.`,
    );
    this.name = "SecretProvisionError";
  }
}

const forbidden = (err: unknown) =>
  err instanceof AgentOperationError && err.code === "HTTP_403";

/** Mint and store the watchdog's read-only key unless its definition already has the secret. */
export async function ensureWatchdogKey(
  client: SecretsClient,
  definitionId: string,
): Promise<ProvisionResult> {
  const { keys } = await client.get<{ keys: string[] }>(
    `/definitions/${definitionId}/secrets`,
  );
  if (keys.includes(WATCHDOG_SECRET)) return { outcome: "present" };

  let minted: { apiKey?: { id?: string }; plainKey?: string };
  try {
    minted = await client.postAtHostRoot("/v1/api-keys/scoped", {
      name: WATCHDOG_KEY_NAME,
      description: "Lets the Sylon watchdog list failed runs. Read-only.",
      permissions: WATCHDOG_PERMISSIONS,
    });
  } catch (err) {
    if (forbidden(err))
      throw new SecretProvisionError("minting was refused (403)");
    throw err;
  }
  if (!minted.plainKey)
    throw new Error("the key service returned no key for the watchdog");
  try {
    await client.post(`/definitions/${definitionId}/secrets`, {
      key: WATCHDOG_SECRET,
      secret: minted.plainKey,
    });
  } catch (err) {
    if (forbidden(err))
      throw new SecretProvisionError("setting the secret was refused (403)");
    throw err;
  }
  return { outcome: "provisioned", keyId: minted.apiKey?.id };
}
