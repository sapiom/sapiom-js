import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readCredentials,
  writeCredentials,
  type ResolvedEnvironment,
} from "../credentials.js";
import { performBrowserAuth, performDeviceAuth } from "../auth.js";
import { z } from "zod";

/**
 * Registers the `sapiom_authenticate` tool. Supports browser-based OAuth
 * (localhost redirect) and RFC 8628 device auth (code entry on another device).
 */
export function register(server: McpServer, env: ResolvedEnvironment): void {
  server.tool(
    "sapiom_authenticate",
    "Authenticate with Sapiom to get an API key. Supports browser login (default) and device code flow for headless environments.",
    {
      method: z
        .enum(["browser", "device"])
        .optional()
        .describe(
          'Auth method: "browser" opens a local browser, "device" displays a code to enter on another device. Defaults to browser with device fallback.',
        ),
    },
    async (args) => {
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

      const method = args.method;

      // Explicit device auth
      if (method === "device") {
        return performDeviceAuthFlow(env);
      }

      // Explicit browser auth
      if (method === "browser") {
        return performBrowserAuthFlow(env);
      }

      // Default: try browser, fall back to device
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
      } catch {
        // Browser auth failed — fall back to device auth
        return performDeviceAuthFlow(env);
      }
    },
  );
}

async function performBrowserAuthFlow(env: ResolvedEnvironment) {
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
      err instanceof Error ? err.message : "Unknown error during authentication";
    return {
      content: [
        {
          type: "text" as const,
          text: `Browser authentication failed: ${message}`,
        },
      ],
      isError: true,
    };
  }
}

async function performDeviceAuthFlow(env: ResolvedEnvironment) {
  try {
    const { initiation, result } = await performDeviceAuth(env.apiURL);

    // Return the code to the user immediately, then wait for approval
    console.error(
      `\nDevice auth: Go to ${initiation.verification_uri} and enter code ${initiation.user_code}\n`,
    );

    const authResult = await result;

    await writeCredentials(env.name, env.appURL, env.apiURL, {
      apiKey: authResult.apiKey,
      tenantId: authResult.tenantId,
      organizationName: authResult.organizationName,
      apiKeyId: authResult.apiKeyId,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully authenticated as ${authResult.organizationName} via device code. Sapiom tools are now ready to use.`,
        },
      ],
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error during authentication";
    return {
      content: [
        {
          type: "text" as const,
          text: `Device authentication failed: ${message}`,
        },
      ],
      isError: true,
    };
  }
}
