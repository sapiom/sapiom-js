/**
 * Registry descriptor for the Codex adapter.
 *
 * The runtime adapter implementation (launch/resume/doctor/listPastSessions)
 * lives in codex.ts. This file carries only the registry-level metadata
 * consumed by the harness listing endpoint and the skills panel Install MCP modal.
 */
import { LOCAL_AUTHORING_MCP_ALIAS } from "../mcp-registration.js";
import type { EmbeddedHarnessAdapterInfo } from "./adapter.js";
import { isExecutableOnPath } from "./detect.js";

const INSTALL_MCP_PROMPT = [
  "Set up the Sapiom MCP server for the Codex CLI.",
  "",
  `1. Register it under the client alias \`${LOCAL_AUTHORING_MCP_ALIAS}\`. Recent Codex versions`,
  "   support:",
  "",
  `   codex mcp add ${LOCAL_AUTHORING_MCP_ALIAS} -- npx -y @sapiom/mcp`,
  "",
  "   Otherwise add it to `~/.codex/config.toml` yourself:",
  "",
  `   [mcp_servers.${LOCAL_AUTHORING_MCP_ALIAS}]`,
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
  // Codex reads images referenced by path in a prompt.
  imageInput: true,
  installMcpPrompt(): string {
    return INSTALL_MCP_PROMPT;
  },
  detectInstalled(): Promise<boolean> {
    return isExecutableOnPath("codex");
  },
};
