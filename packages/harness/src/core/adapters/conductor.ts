/**
 * Conductor — a macOS app (conductor.build) that runs Claude Code agents
 * in parallel workspaces. Conductor owns its sessions entirely, so this
 * adapter is external/companion mode: detection and setup guidance only.
 * There is deliberately no spawn path.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExternalHarnessAdapterInfo } from "./adapter.js";

const INSTALL_MCP_PROMPT = [
  "Set up the Sapiom MCP server for Conductor.",
  "",
  "Conductor workspaces run Claude Code, so register the server with Claude",
  "Code at project scope — every workspace of the repository then inherits",
  "it:",
  "",
  "1. From the repository root, run:",
  "",
  "   claude mcp add --scope project sapiom-dev -- npx -y @sapiom/mcp",
  "",
  "   This writes the server into the repository's `.mcp.json`, which",
  "   Conductor workspaces pick up. The `@sapiom/mcp` npm package ships the",
  "   `sapiom-mcp` binary, a local MCP server that speaks stdio.",
  "2. Commit `.mcp.json` if the whole team should get the server.",
  "3. Restart the Conductor workspace so the new server is loaded.",
].join("\n");

/**
 * Where the Conductor app bundle can live. Exported for tests; returns an
 * empty list on platforms Conductor does not ship for.
 */
export function conductorAppCandidates(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string[] {
  if (platform !== "darwin") return [];
  return [
    "/Applications/Conductor.app",
    path.join(homeDir, "Applications", "Conductor.app"),
  ];
}

export const conductorAdapterInfo: ExternalHarnessAdapterInfo = {
  id: "conductor",
  label: "Conductor",
  mode: "external",
  installMcpPrompt(): string {
    return INSTALL_MCP_PROMPT;
  },
  async detectInstalled(): Promise<boolean> {
    return conductorAppCandidates().some((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
  },
};
