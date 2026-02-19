import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";
import { getAuthenticatedFetch } from "./shared.js";
import { PROVIDER_SCOPES } from "@sapiom/app-auth";

const DEFAULT_AUTH0_URL = "https://auth0.services.sapiom.ai";

function buildScopeReference(): string {
  const lines: string[] = ["Available scopes per provider:"];
  for (const [provider, scopes] of Object.entries(PROVIDER_SCOPES)) {
    const scopeList = scopes.map((s) => s.name).join(", ");
    lines.push(`  ${provider}: ${scopeList}`);
  }
  return lines.join("\n");
}

/** Raw response shape from the gateway POST /v1/apps */
interface GatewayCreateAppResponse {
  appId: string;
  id: string;
  authBaseUrl: string;
  status: string;
  providers: string[];
  jwtSecret: string;
}

/** Raw response shape from the gateway GET /v1/apps/:appId */
interface GatewayGetAppResponse {
  appId: string;
  id: string;
  authBaseUrl: string;
  status: string;
  providers: string[];
  createdAt: string;
}

function buildIntegrationGuide(
  gw: GatewayCreateAppResponse,
  connectionScopes?: Record<string, string[]>,
): string {
  // Map gateway field names to SDK config names
  const appId = gw.appId;
  const appUuid = gw.id;
  const gatewayUrl = gw.authBaseUrl;
  const jwtSecret = gw.jwtSecret;

  const scopeLines = connectionScopes
    ? Object.entries(connectionScopes)
        .map(([provider, scopes]) => `  - **${provider}:** ${scopes.join(", ")}`)
        .join("\n")
    : null;

  const providerInfo = `- **Providers:** ${gw.providers.join(", ")}${scopeLines ? `\n- **Connection Scopes:**\n${scopeLines}` : ""}`;

  const scopeRef = buildScopeReference();

  return `## Auth App Created Successfully

${providerInfo}

## Step 1: Environment Variables

**IMPORTANT:** The app requires a \`SAPIOM_API_KEY\` for x402 payment handling on backend operations. Check if the project already has one in \`.env\` or \`.env.local\`. If not, create one with the \`sapiom_create_api_key\` tool or ask the user for their key.

Add to your \`.env\` file (these are secrets — **never expose to the frontend or commit to git**):

\`\`\`
SAPIOM_API_KEY=          # Required — x402 payment key for backend SDK calls
SAPIOM_AUTH_APP_ID=${appId}
SAPIOM_AUTH_APP_UUID=${appUuid}
SAPIOM_AUTH_GATEWAY_URL=${gatewayUrl}
SAPIOM_AUTH_JWT_SECRET=${jwtSecret}
\`\`\`

## Step 2: Install SDKs

\`\`\`bash
npm install @sapiom/app-auth @sapiom/app-auth-react
\`\`\`

Use \`@sapiom/app-auth\` for backend auth logic and \`@sapiom/app-auth-react\` for React UI components. Do NOT implement auth flows manually — the SDKs handle popup management, postMessage listeners, JWT verification, and x402 payments.

**Next.js projects:** Add this to \`next.config.js\` to prevent webpack from bundling server-only dependencies:

\`\`\`js
const nextConfig = {
  serverExternalPackages: ["@sapiom/fetch", "jsonwebtoken"],
};
\`\`\`

## Step 3: Backend — Initialize SapiomAuth

Create a server-side auth instance with all credentials. This handles JWT session verification and x402-gated token retrieval:

\`\`\`js
// lib/auth.js (or similar server-side module)
import { SapiomAuth } from "@sapiom/app-auth";

export const auth = new SapiomAuth({
  appId: process.env.SAPIOM_AUTH_APP_ID,
  appUuid: process.env.SAPIOM_AUTH_APP_UUID,
  gatewayUrl: process.env.SAPIOM_AUTH_GATEWAY_URL,
  jwtSecret: process.env.SAPIOM_AUTH_JWT_SECRET,
  apiKey: process.env.SAPIOM_API_KEY,
});
\`\`\`

### Verify a session (no network call — local JWT check):

\`\`\`js
const user = await auth.getUser(sessionToken);
// user: { sub, appId, accountId, sessionId, iat, exp }
\`\`\`

### Retrieve a connected OAuth token (x402 payment, call from API route only):

\`\`\`js
const { accessToken, scopes } = await auth.getConnection(sessionToken, "github");
// Use accessToken to call the provider's API (e.g., api.github.com)
\`\`\`

## Step 4: Frontend — Initialize SapiomAuth

Create a client-side auth instance with **only public config** (no secrets):

\`\`\`js
import { SapiomAuth } from "@sapiom/app-auth";

const auth = new SapiomAuth({
  appId: "${appId}",
  appUuid: "${appUuid}",
  gatewayUrl: "${gatewayUrl}",
});
\`\`\`

Note: On the frontend, \`appId\`, \`appUuid\`, and \`gatewayUrl\` are public values — they only identify the app and build popup URLs.

## Step 5: Frontend — Login Button

\`\`\`jsx
import { LoginButton } from "@sapiom/app-auth-react";

<LoginButton
  auth={auth}
  onLogin={(sessionToken, userId) => {
    // Store sessionToken in state
    // Send as Authorization: Bearer header to your backend API routes
  }}
  onError={(error) => console.error(error)}
>
  Log in
</LoginButton>
\`\`\`

## Step 6: Frontend — Connect OAuth Provider

After login, connect a service (e.g., GitHub). Pass optional \`scopes\` to request specific permissions:

\`\`\`jsx
import { ConnectButton } from "@sapiom/app-auth-react";

<ConnectButton
  auth={auth}
  service="github"
  sessionToken={sessionToken}
  scopes={["read:user", "user:email"]}
  onConnect={(service) => {
    // Service is now connected
    // Call your backend API to retrieve and use the OAuth token
  }}
  onError={(error) => console.error(error)}
>
  Connect GitHub
</ConnectButton>
\`\`\`

## Step 7: Frontend — Logout

\`\`\`js
const logoutUrl = auth.getLogoutUrl(sessionToken);
window.open(logoutUrl, "sapiom-auth");
// Clear local session state
\`\`\`

## Available OAuth Scopes

${scopeRef}`;
}

export function register(server: McpServer, env: ResolvedEnvironment): void {
  const auth0URL = env.services.auth0 ?? DEFAULT_AUTH0_URL;

  server.tool(
    "sapiom_auth_create_app",
    `Add social login and OAuth to a web app. Creates a fully configured auth backend with login, session management, and OAuth token retrieval for providers like GitHub, Google, Slack, Discord, and more.

Use this tool when the user wants to:
- Add social login / OAuth login to their app
- Let users sign in with GitHub, Google, Slack, Discord, Twitter, LinkedIn, Microsoft, or Apple
- Access OAuth tokens for connected services (e.g., read a user's GitHub repos, send Slack messages)

Prerequisites:
- The app being built needs a SAPIOM_API_KEY in its .env for x402 payment handling. Check if the project already has one. If not, use the sapiom_create_api_key tool to create one, or ask the user.

The tool returns credentials and a step-by-step SDK integration guide. Always follow the guide — use @sapiom/app-auth (backend) and @sapiom/app-auth-react (React components). Do not implement auth flows manually.`,
    {
      name: z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
          "Name must be a lowercase slug (e.g. my-app-name)",
        )
        .describe("Slug identifier for the app (e.g. my-cool-app)"),
      displayName: z
        .string()
        .optional()
        .describe("Human-readable display name for the app"),
      providers: z
        .array(z.string())
        .min(1)
        .describe(
          'OAuth providers to enable. Common values: "github", "google-oauth2", "discord", "slack", "twitter", "linkedin", "microsoft", "apple". Use ["github"] if the user doesn\'t specify.',
        ),
      connectionScopes: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Per-provider OAuth scopes to request. If not specified, defaults are used. Example: {"github": ["read:user", "user:email"], "google-oauth2": ["email", "profile"]}',
        ),
    },
    async ({ name, displayName, providers, connectionScopes }) => {
      const sfetch = await getAuthenticatedFetch(env);
      if (!sfetch) {
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
        const body: Record<string, unknown> = { name, providers };
        if (displayName) body.displayName = displayName;
        if (connectionScopes) body.connectionScopes = connectionScopes;

        const response = await sfetch(`${auth0URL}/v1/apps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errBody = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const message =
            (errBody.message as string) ??
            `Failed to create auth app (${response.status})`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }

        const data = (await response.json()) as GatewayCreateAppResponse;
        return {
          content: [
            { type: "text" as const, text: buildIntegrationGuide(data, connectionScopes) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create auth app: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "sapiom_auth_get_app",
    "Get details and status of an existing auth app.",
    {
      appId: z.string().describe("The app ID returned by sapiom_auth_create_app"),
    },
    async ({ appId }) => {
      const sfetch = await getAuthenticatedFetch(env);
      if (!sfetch) {
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
        const response = await sfetch(`${auth0URL}/v1/apps/${appId}`, {
          method: "GET",
        });

        if (!response.ok) {
          const errBody = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const message =
            (errBody.message as string) ??
            `Failed to get auth app (${response.status})`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }

        const data = (await response.json()) as GatewayGetAppResponse;
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `## Auth App: ${data.appId}`,
                "",
                `- **App ID (appId):** ${data.appId}`,
                `- **App UUID (appUuid):** ${data.id}`,
                `- **Gateway URL (gatewayUrl):** ${data.authBaseUrl}`,
                `- **Status:** ${data.status}`,
                `- **Providers:** ${data.providers.join(", ")}`,
                `- **Created At:** ${data.createdAt}`,
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
              text: `Failed to get auth app: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "sapiom_auth_delete_app",
    "Delete an auth app and its associated Auth0 resources.",
    {
      appId: z.string().describe("The app ID to delete"),
    },
    async ({ appId }) => {
      const sfetch = await getAuthenticatedFetch(env);
      if (!sfetch) {
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
        const response = await sfetch(`${auth0URL}/v1/apps/${appId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const errBody = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const message =
            (errBody.message as string) ??
            `Failed to delete auth app (${response.status})`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Auth app "${appId}" has been deleted successfully.`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to delete auth app: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
