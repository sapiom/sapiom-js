import { SapiomClient } from "@sapiom/core";
import { createFetch } from "@sapiom/fetch";
import { readCredentials, type ResolvedEnvironment } from "./credentials.js";

/**
 * Build an authenticated fetch instance for the current environment.
 * @internal
 */
export async function getAuthenticatedFetch(
  env: ResolvedEnvironment,
): Promise<ReturnType<typeof createFetch> | null> {
  const creds = await readCredentials(env.name);
  if (!creds) return null;

  return createFetch({
    apiKey: creds.apiKey,
    baseURL: env.apiURL,
    agentName: "sapiom-mcp",
    integration: { name: "@sapiom/mcp", version: "0.1.0" },
  });
}

/**
 * Build an authenticated {@link SapiomClient} for the current environment.
 * @internal
 */
export async function getAuthenticatedClient(
  env: ResolvedEnvironment,
): Promise<SapiomClient | null> {
  const creds = await readCredentials(env.name);
  if (!creds) return null;

  return new SapiomClient({
    apiKey: creds.apiKey,
    baseURL: env.apiURL,
  });
}
