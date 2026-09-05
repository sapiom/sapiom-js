#!/usr/bin/env node

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSapiomOpenCodeConfig } from "./config.js";
import { startOpenCodeStandalone } from "./standalone.js";

interface CliOptions {
  cwd: string;
  enableMcp: boolean;
  model: string;
  port?: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.env.SAPIOM_API_KEY === undefined) {
    throw new Error(
      "SAPIOM_API_KEY is required for the Sapiom model and MCP endpoints.",
    );
  }

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "web");
  const workspaceKey = createHash("sha256")
    .update(options.cwd)
    .digest("hex")
    .slice(0, 12);
  const stateRoot = join(homedir(), ".sapiom", "opencode", workspaceKey);
  const apiBaseUrl = stripTrailingSlashes(
    process.env.SAPIOM_API_URL ?? "https://api.sapiom.ai",
  );
  const config = createSapiomOpenCodeConfig({
    routingLabel: options.model,
    llmBaseUrl: process.env.SAPIOM_LLM_URL,
    mcpUrl: process.env.SAPIOM_MCP_URL ?? `${apiBaseUrl}/v1/mcp`,
    enableMcp: options.enableMcp,
  });

  const app = await startOpenCodeStandalone({
    ...(process.env.SAPIOM_OPENCODE_BIN
      ? { command: { executable: process.env.SAPIOM_OPENCODE_BIN } }
      : {}),
    cwd: options.cwd,
    stateRoot,
    config,
    webRoot,
    port: options.port,
  });

  console.log(`Sapiom OpenCode POC: ${app.origin}`);
  console.log(`Workspace: ${options.cwd}`);
  console.log(`Model route: ${options.model}`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

function parseArgs(args: string[]): CliOptions {
  let cwd = process.cwd();
  let enableMcp = true;
  let model = process.env.SAPIOM_MODEL ?? "smart";
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    }
    if (argument === "--no-mcp") {
      enableMcp = false;
      continue;
    }
    if (argument === "--model") {
      model = requiredValue(args, ++index, "--model");
      continue;
    }
    if (argument === "--port") {
      port = Number(requiredValue(args, ++index, "--port"));
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535.");
      }
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    cwd = resolve(argument ?? cwd);
  }

  return { cwd, enableMcp, model, port };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined) throw new Error(`${option} requires a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: sapiom-opencode [directory] [options]

Options:
  --model <label>  Sapiom routing label (default: SAPIOM_MODEL or smart)
  --no-mcp         Disable the Sapiom MCP server
  --port <number>  UI port (default: random localhost port)
  -h, --help       Show this help

Environment:
  SAPIOM_API_KEY       Required Sapiom credential
  SAPIOM_LLM_URL       Override https://llm.services.sapiom.ai
  SAPIOM_API_URL       Override https://api.sapiom.ai
  SAPIOM_MCP_URL       Override the complete MCP endpoint
  SAPIOM_OPENCODE_BIN  Override the OpenCode executable`);
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sapiom-opencode: ${message}`);
  process.exitCode = 1;
});
