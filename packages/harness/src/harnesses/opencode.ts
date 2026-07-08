/**
 * opencode — an open-source coding agent TUI (`opencode`). Scaffold
 * adapter: detection is real; launch support is best-effort and marked
 * `experimental` until it is exercised by an end-to-end suite.
 */
import type { EmbeddedHarnessAdapter } from "./adapter.js";
import { isExecutableOnPath } from "./detect.js";

const INSTALL_MCP_PROMPT = [
  "Set up the Sapiom MCP server for opencode.",
  "",
  "1. Add it to opencode's config — the project's `opencode.json`, or the",
  "   global `~/.config/opencode/opencode.json`:",
  "",
  "   {",
  '     "mcp": {',
  '       "sapiom-dev": {',
  '         "type": "local",',
  '         "command": ["npx", "-y", "@sapiom/mcp"],',
  '         "enabled": true',
  "       }",
  "     }",
  "   }",
  "",
  "   The `@sapiom/mcp` npm package ships the `sapiom-mcp` binary, a local",
  "   MCP server that speaks stdio.",
  "2. Restart opencode so the server is loaded, then confirm the Sapiom",
  "   tools are listed.",
].join("\n");

/**
 * The opencode adapter. `promptDelivery` is `inline`: the TUI accepts an
 * initial prompt via `--prompt` and opens normally without one.
 */
export const opencodeAdapter: EmbeddedHarnessAdapter = {
  id: "opencode",
  label: "opencode",
  mode: "embedded",
  promptDelivery: "inline",
  experimental: true,

  launchCommand(cfg) {
    const args: string[] = [];
    if (cfg.prompt !== undefined) {
      args.push("--prompt", cfg.prompt);
    }
    return { command: "opencode", args, env: { ...cfg.env } };
  },

  installMcpPrompt() {
    return INSTALL_MCP_PROMPT;
  },

  detectInstalled() {
    return isExecutableOnPath("opencode");
  },
};
