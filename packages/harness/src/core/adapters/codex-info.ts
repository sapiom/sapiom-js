/**
 * Registry descriptor for the Codex adapter.
 *
 * The runtime adapter implementation (launch/resume/doctor/listPastSessions)
 * lives in codex.ts. This file carries only the registry-level metadata
 * consumed by the harness listing endpoint and the skills panel Install MCP modal.
 */
import type { EmbeddedHarnessAdapterInfo } from "./adapter.js";
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

export const codexAdapterInfo: EmbeddedHarnessAdapterInfo = {
  id: "codex",
  label: "Codex CLI",
  mode: "embedded",
  installMcpPrompt(): string {
    return INSTALL_MCP_PROMPT;
  },
  detectInstalled(): Promise<boolean> {
    return isExecutableOnPath("codex");
  },
};
