#!/usr/bin/env node

/**
 * @packageDocumentation
 *
 * Sapiom MCP server binary. This package is meant to be run as a
 * standalone process (via `npx @sapiom/mcp`), not imported as a library.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveEnvironment } from "./credentials.js";
import { register as registerAuthenticate } from "./tools/authenticate.js";
import { register as registerStatus } from "./tools/status.js";
import { register as registerVerify } from "./tools/verify.js";
import { register as registerApiKeys } from "./tools/api-keys.js";

async function main(): Promise<void> {
  // Resolve environment: SAPIOM_ENVIRONMENT env var > file > "production"
  const env = await resolveEnvironment(process.env.SAPIOM_ENVIRONMENT);

  if (env.name !== "production") {
    console.error(
      `\u26a0 Using environment "${env.name}": app=${env.appURL} api=${env.apiURL}`,
    );
  }

  const server = new McpServer({
    name: "sapiom",
    version: "0.1.0",
  });

  // Register all tools
  registerAuthenticate(server, env);
  registerStatus(server, env);
  registerVerify(server, env);
  registerApiKeys(server, env);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sapiom MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
