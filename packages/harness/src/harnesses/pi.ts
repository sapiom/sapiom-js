/**
 * pi — a minimal open-source coding agent CLI (`pi`). Scaffold adapter:
 * detection is real; launch support is best-effort and marked
 * `experimental` until it is exercised by an end-to-end suite.
 */
import type { EmbeddedHarnessAdapter } from "./adapter.js";
import { isExecutableOnPath } from "./detect.js";

const INSTALL_MCP_PROMPT = [
  "Set up the Sapiom MCP server for pi.",
  "",
  "The Sapiom MCP server is the `sapiom-mcp` binary from the `@sapiom/mcp`",
  "npm package — a local stdio MCP server started with `npx -y @sapiom/mcp`.",
  "MCP support varies between pi versions: check `pi --help` and pi's",
  "documentation for how your version registers stdio MCP servers, and",
  "register the command above under the name `sapiom-dev`. If your pi",
  "version has no MCP support, say so instead of guessing.",
].join("\n");

/**
 * The pi adapter. `promptDelivery` is `inline`: `pi` accepts an initial
 * prompt as its first positional argument and runs interactively with or
 * without one.
 */
export const piAdapter: EmbeddedHarnessAdapter = {
  id: "pi",
  label: "pi",
  mode: "embedded",
  promptDelivery: "inline",
  experimental: true,

  launchCommand(cfg) {
    const args: string[] = [];
    if (cfg.prompt !== undefined) {
      args.push(cfg.prompt);
    }
    return { command: "pi", args, env: { ...cfg.env } };
  },

  installMcpPrompt() {
    return INSTALL_MCP_PROMPT;
  },

  detectInstalled() {
    return isExecutableOnPath("pi");
  },
};
