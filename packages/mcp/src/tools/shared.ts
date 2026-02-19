import { createFetch } from "@sapiom/fetch";
import { readCredentials, type ResolvedEnvironment } from "../credentials.js";

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
