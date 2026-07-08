import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readCredentials,
  writeCredentials,
  type ResolvedEnvironment,
} from "../credentials.js";
import { performBrowserAuth } from "../auth.js";

export function register(server: McpServer, env: ResolvedEnvironment): void {
  server.tool(
    "sapiom_authenticate",
    "Authenticate this local Sapiom developer MCP (sapiom-dev) by opening a browser login flow. Run this when a networked agent tool (link/deploy/run/inspect/signal) reports that authentication is required.",
    {},
    async () => {
      // Check if already authenticated
      const existing = await readCredentials(env.name);
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Already authenticated as ${existing.organizationName} (tenant: ${existing.tenantId}). To re-authenticate, use sapiom_logout first.`,
            },
          ],
        };
      }

      try {
        const result = await performBrowserAuth(env.appURL, env.apiURL);

        await writeCredentials(env.name, env.appURL, env.apiURL, {
          apiKey: result.apiKey,
          tenantId: result.tenantId,
          organizationName: result.organizationName,
          apiKeyId: result.apiKeyId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully authenticated as ${result.organizationName}. Sapiom tools are now ready to use.`,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Unknown error during authentication";
        return {
          content: [
            {
              type: "text" as const,
              text: `Authentication failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
