/**
 * Claude Code — Anthropic's coding agent CLI (`claude`). Fully supported:
 * launched embedded in a pty session, with prompts injected post-launch.
 */
import type { EmbeddedHarnessAdapter } from "./adapter.js";
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

/**
 * The claude-code adapter.
 *
 * - `launchCommand` starts the plain interactive TUI. Sessions spawn
 *   without a shell (node-pty passes argv directly), so every argument —
 *   including the optional appended system prompt, which is literal
 *   content, not a file path — reaches `claude` exactly as provided;
 *   nothing is interpolated, quoted, or word-split.
 * - `promptDelivery` is `post-launch`: the interactive TUI takes no
 *   pre-submitted prompt flag, so the prompt is written into the pty once
 *   the session has booted.
 * - `detectInstalled` is a pure-Node `PATH` lookup for the `claude`
 *   binary (with `PATHEXT` handling on Windows).
 */
export const claudeCodeAdapter: EmbeddedHarnessAdapter = {
  id: "claude-code",
  label: "Claude Code",
  mode: "embedded",
  promptDelivery: "post-launch",

  launchCommand(cfg) {
    const args: string[] = [];
    if (cfg.appendSystemPrompt !== undefined) {
      args.push("--append-system-prompt", cfg.appendSystemPrompt);
    }
    // cfg.prompt is intentionally unused: delivery is post-launch.
    return { command: "claude", args, env: { ...cfg.env } };
  },

  installMcpPrompt() {
    return INSTALL_MCP_PROMPT;
  },

  detectInstalled() {
    return isExecutableOnPath("claude");
  },
};
