#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveEnvironment } from "./credentials.js";
import { register as registerAuthenticate } from "./tools/authenticate.js";
import { register as registerStatus } from "./tools/status.js";
import { register as registerOrchestrations } from "./tools/orchestrations.js";
import { AUTHORING_INSTRUCTIONS } from "./instructions.js";

async function main(): Promise<void> {
  // Resolve environment: SAPIOM_ENVIRONMENT env var > file > "production"
  const env = await resolveEnvironment(process.env.SAPIOM_ENVIRONMENT);

  if (env.name !== "production") {
    console.error(
      `\u26a0 Using environment "${env.name}": app=${env.appURL} api=${env.apiURL}`,
    );
  }

  const server = new McpServer(
    {
      // The local dev surface — distinct from the remote Sapiom capabilities MCP.
      name: "sapiom-dev",
      version: "0.1.0",
    },
    {
      // Auto-delivered to capable clients on connect (the MCP `initialize` handshake),
      // so any agent that adds this server gets the workflow-authoring primer with no
      // skill install or docs hand-off. See ./instructions.ts.
      instructions: AUTHORING_INSTRUCTIONS,
    },
  );

  // Register all tools
  registerAuthenticate(server, env);
  registerStatus(server, env);
  registerOrchestrations(server, env);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sapiom dev MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
