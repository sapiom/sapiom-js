import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readCredentials,
  clearCredentials,
  type ResolvedEnvironment,
} from "../credentials.js";
import { registerTool } from "../register-tool.js";

export function register(server: McpServer, env: ResolvedEnvironment): void {
  registerTool(
    server,
    "sapiom_status",
    "Check authentication status for this local Sapiom developer MCP (sapiom-dev). Returns whether you're authenticated and which organization.",
    {},
    async () => {
      const creds = await readCredentials(env.name);

      if (creds) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Authenticated as ${creds.organizationName} (tenant: ${creds.tenantId})`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Not authenticated. Use the sapiom_authenticate tool to log in.",
          },
        ],
      };
    },
  );

  registerTool(
    server,
    "sapiom_logout",
    "Log out of Sapiom by removing cached credentials for the current environment.",
    {},
    async () => {
      await clearCredentials(env.name);

      return {
        content: [
          {
            type: "text" as const,
            text: "Logged out successfully. Cached credentials have been removed.",
          },
        ],
      };
    },
  );
}
