/**
 * pi — a minimal open-source coding agent CLI.
 * Scaffold adapter: detection is real; launch support is best-effort and
 * marked `experimental` until exercised by an end-to-end suite.
 */
import type { EmbeddedHarnessAdapterInfo } from "./adapter.js";
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

export const piAdapterInfo: EmbeddedHarnessAdapterInfo = {
  id: "pi",
  label: "pi",
  mode: "embedded",
  experimental: true,
  installMcpPrompt(): string {
    return INSTALL_MCP_PROMPT;
  },
  detectInstalled(): Promise<boolean> {
    return isExecutableOnPath("pi");
  },
};
