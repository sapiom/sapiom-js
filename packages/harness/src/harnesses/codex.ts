/**
 * Codex CLI — OpenAI's coding agent (`codex`). Scaffold adapter: detection
 * is real; launch support is best-effort and marked `experimental` until
 * it is exercised by an end-to-end suite.
 */
import type { EmbeddedHarnessAdapter } from "./adapter.js";
import { isExecutableOnPath } from "./detect.js";

const INSTALL_MCP_PROMPT = [
  "Set up the Sapiom MCP server for the Codex CLI.",
  "",
  "1. Register it under the server name `sapiom-dev`. Recent Codex versions",
  "   support:",
  "",
  "   codex mcp add sapiom-dev -- npx -y @sapiom/mcp",
  "",
  "   Otherwise add it to `~/.codex/config.toml` yourself:",
  "",
  "   [mcp_servers.sapiom-dev]",
  '   command = "npx"',
  '   args = ["-y", "@sapiom/mcp"]',
  "",
  "   The `@sapiom/mcp` npm package ships the `sapiom-mcp` binary, a local",
  "   MCP server that speaks stdio.",
  "2. Restart Codex so the server is loaded, then confirm the Sapiom tools",
  "   are listed.",
].join("\n");

/**
 * The codex adapter. `promptDelivery` is `inline`: `codex` takes an
 * initial prompt as its first positional argument and opens its
 * interactive UI with or without one.
 */
export const codexAdapter: EmbeddedHarnessAdapter = {
  id: "codex",
  label: "Codex CLI",
  mode: "embedded",
  promptDelivery: "inline",
  experimental: true,

  launchCommand(cfg) {
    const args: string[] = [];
    if (cfg.prompt !== undefined) {
      args.push(cfg.prompt);
    }
    return { command: "codex", args, env: { ...cfg.env } };
  },

  installMcpPrompt() {
    return INSTALL_MCP_PROMPT;
  },

  detectInstalled() {
    return isExecutableOnPath("codex");
  },
};
