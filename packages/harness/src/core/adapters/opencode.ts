/**
 * opencode — an open-source coding agent TUI.
 * Scaffold adapter: detection is real; launch support is best-effort and
 * marked `experimental` until exercised by an end-to-end suite.
 */
import type { EmbeddedHarnessAdapterInfo } from "./adapter.js";
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

export const opencodeAdapterInfo: EmbeddedHarnessAdapterInfo = {
  id: "opencode",
  label: "opencode",
  mode: "embedded",
  experimental: true,
  installMcpPrompt(): string {
    return INSTALL_MCP_PROMPT;
  },
  detectInstalled(): Promise<boolean> {
    return isExecutableOnPath("opencode");
  },
};
