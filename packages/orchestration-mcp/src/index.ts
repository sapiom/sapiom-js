#!/usr/bin/env node

/**
 * @sapiom/orchestration-mcp — stdio MCP server
 *
 * Exposes @sapiom/orchestration-core as MCP tools so that an MCP client
 * (e.g. Claude Code) can scaffold, validate, link, deploy, run, inspect,
 * and signal orchestrations without leaving the editor.
 *
 * Host and API key resolution mirrors the CLI: SAPIOM_HOST / SAPIOM_API_KEY
 * env vars take precedence, then ~/.sapiom/config.json, then sapiom.json,
 * then the production default. Credentials written by `sapiom login` are
 * shared transparently.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { register as registerScaffold } from "./tools/scaffold.js";
import { register as registerCheck } from "./tools/check.js";
import { register as registerLink } from "./tools/link.js";
import { register as registerDeploy } from "./tools/deploy.js";
import { register as registerRun } from "./tools/run.js";
import { register as registerStatus } from "./tools/status.js";
import { register as registerLogs } from "./tools/logs.js";
import { register as registerSignal } from "./tools/signal.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "sapiom-orchestration",
    version: "0.1.0",
  });

  registerScaffold(server);
  registerCheck(server);
  registerLink(server);
  registerDeploy(server);
  registerRun(server);
  registerStatus(server);
  registerLogs(server);
  registerSignal(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sapiom orchestration MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
