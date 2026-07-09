/**
 * Registry descriptor for the Claude Code adapter.
 *
 * The runtime adapter implementation (launch/resume/doctor/listPastSessions)
 * lives in claude-code.ts. This file carries only the registry-level metadata
 * consumed by the harness listing endpoint and the skills panel Install MCP
 * modal: the human label, spawn mode, MCP install guidance, and PATH detection.
 */
import type { EmbeddedHarnessAdapterInfo } from "./adapter.js";
import { isExecutableOnPath } from "./detect.js";

const INSTALL_MCP_PROMPT = [
  "Set up the Sapiom MCP server for Claude Code.",
  "",
  "1. Register it under the server name `sapiom-dev`:",
  "",
  "   claude mcp add sapiom-dev -- npx -y @sapiom/mcp",
  "",
  "   The `@sapiom/mcp` npm package ships the `sapiom-mcp` binary, a local",
  "   MCP server that speaks stdio — no global install or daemon needed.",
  "2. Verify the registration: `claude mcp list` should show `sapiom-dev`.",
  "3. Restart Claude Code (or start a new session) so the server is loaded.",
  "4. Networked Sapiom tools need an API key: run the `sapiom_authenticate`",
  "   tool once and complete the browser login it opens.",
].join("\n");

export const claudeCodeAdapterInfo: EmbeddedHarnessAdapterInfo = {
  id: "claude-code",
  label: "Claude Code",
  mode: "embedded",
  installMcpPrompt(): string {
    return INSTALL_MCP_PROMPT;
  },
  detectInstalled(): Promise<boolean> {
    return isExecutableOnPath("claude");
  },
};
