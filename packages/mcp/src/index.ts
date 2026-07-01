#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveEnvironment } from "./credentials.js";
import { register as registerAuthenticate } from "./tools/authenticate.js";
import { register as registerStatus } from "./tools/status.js";
import { register as registerOrchestrations } from "./tools/orchestrations.js";
import { fetchInstructions } from "./instructions-fetch.js";

async function main(): Promise<void> {
  // Resolve environment: SAPIOM_ENVIRONMENT env var > file > "production"
  const env = await resolveEnvironment(process.env.SAPIOM_ENVIRONMENT);

  if (env.name !== "production") {
    console.error(
      `\u26a0 Using environment "${env.name}": app=${env.appURL} api=${env.apiURL}`,
    );
  }

  // Pull the latest authoring instructions from the backend (falls back to the
  // bundled copy offline / on error), so guidance can change without a release.
  const instructions = await fetchInstructions(env);

  const server = new McpServer(
    {
      // The local developer surface — distinct from the remote Sapiom
      // capabilities MCP. This is the unmetered `sapiom_dev_*` namespace for
      // building and operating on Sapiom (today: orchestration authoring &
      // lifecycle; room for more dev tooling later). The `name` is the stable
      // wire identifier; `title` and `description` are what MCP clients show, so
      // they spell out which Sapiom this is to keep it from reading as a
      // duplicate of the capability server.
      name: "sapiom-dev",
      title: "Sapiom Dev — local developer tools",
      description:
        "The local, unmetered Sapiom developer MCP (sapiom_dev_*). Today it scaffolds, tests, deploys, and inspects orchestrations. Not the remote Sapiom capability MCP — it makes no paid capability calls.",
      version: "0.1.0",
    },
    {
      // Returned in the MCP `initialize` handshake; capable clients surface it to the
      // model on connect, so an agent that adds this server gets the authoring primer
      // automatically. Fetched from the backend; bundled fallback in ./instructions.ts.
      instructions,
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
