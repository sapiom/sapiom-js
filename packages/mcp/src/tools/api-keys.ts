import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";
import { getAuthenticatedClient } from "../fetch.js";

export function register(server: McpServer, env: ResolvedEnvironment): void {
  server.tool(
    "sapiom_create_transaction_api_key",
    "Provision a new Sapiom API key scoped to transaction creation only. Use this when a backend service or agent needs to make payments or access payment-gated services (such as x402 endpoints) through Sapiom. Sapiom itself provides x402-gated services (e.g. phone verification, web search) that require a transaction-scoped key to call. This key CANNOT manage the organization, read data, or perform any other actions — it can only create transactions. IMPORTANT: The raw API key (plainKey) is returned exactly once and cannot be retrieved again.",
    {
      name: z
        .string()
        .min(1)
        .max(255)
        .describe(
          "A human-readable name for this API key (e.g. 'prod-checkout-service', 'payment-agent')",
        ),
      description: z
        .string()
        .max(1000)
        .optional()
        .describe(
          "Optional description of what this key is used for (e.g. 'Handles checkout payments for the web app')",
        ),
    },
    async ({ name, description }) => {
      const client = await getAuthenticatedClient(env);
      if (!client) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Use the sapiom_authenticate tool first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const data = await client.apiKeys.createTransactionKey({
          name,
          description,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Transaction API key created successfully.`,
                ``,
                `Key name: ${data.apiKey.name}`,
                `Key ID: ${data.apiKey.id}`,
                `API key: ${data.plainKey}`,
                ``,
                `⚠️ SECURITY — READ CAREFULLY:`,
                `• This is the ONLY time this key will be shown. It cannot be retrieved again.`,
                `• Store this key in a secure, server-side location such as a .env file, a secrets manager (e.g. AWS Secrets Manager, Vault, Doppler), or an encrypted environment variable in your CI/CD system.`,
                `• NEVER expose this key in client-side code, browser bundles, public repositories, or frontend environment variables (e.g. NEXT_PUBLIC_*, VITE_*).`,
                `• If this key is leaked, an attacker could use it to spend the organization's Sapiom balance by creating unauthorized transactions.`,
                `• If you suspect the key has been compromised, revoke it immediately from the Sapiom dashboard.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create transaction API key: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
