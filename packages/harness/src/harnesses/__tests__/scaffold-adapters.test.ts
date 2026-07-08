/**
 * The embedded scaffold adapters (codex, pi, opencode): best-effort
 * launch commands with inline prompt delivery, honest per-harness MCP
 * install prompts, and the `experimental` marker.
 */
import type { EmbeddedHarnessAdapter } from "../adapter.js";
import { codexAdapter } from "../codex.js";
import { opencodeAdapter } from "../opencode.js";
import { piAdapter } from "../pi.js";

interface ScaffoldCase {
  adapter: EmbeddedHarnessAdapter;
  binary: string;
  /** argv expected when an inline prompt is provided. */
  promptArgs: (prompt: string) => string[];
  /** A string the MCP install prompt must contain (its config surface). */
  installPromptMentions: string;
}

const CASES: ScaffoldCase[] = [
  {
    adapter: codexAdapter,
    binary: "codex",
    promptArgs: (prompt) => [prompt],
    installPromptMentions: "config.toml",
  },
  {
    adapter: piAdapter,
    binary: "pi",
    promptArgs: (prompt) => [prompt],
    installPromptMentions: "npx -y @sapiom/mcp",
  },
  {
    adapter: opencodeAdapter,
    binary: "opencode",
    promptArgs: (prompt) => ["--prompt", prompt],
    installPromptMentions: "opencode.json",
  },
];

describe.each(CASES.map((c) => [c.adapter.id, c] as const))(
  "%s scaffold adapter",
  (_id, { adapter, binary, promptArgs, installPromptMentions }) => {
    it("is an experimental embedded adapter with inline prompt delivery", () => {
      expect(adapter.mode).toBe("embedded");
      expect(adapter.promptDelivery).toBe("inline");
      expect(adapter.experimental).toBe(true);
    });

    it(`launches the ${binary} binary without arguments by default`, () => {
      const launch = adapter.launchCommand({ env: { PATH: "/usr/bin" } });
      expect(launch).toEqual({
        command: binary,
        args: [],
        env: { PATH: "/usr/bin" },
      });
    });

    it("delivers an inline prompt as literal argv", () => {
      const prompt = 'fix the bug in "src" — $(echo untouched)';
      const launch = adapter.launchCommand({ env: {}, prompt });
      expect(launch.args).toEqual(promptArgs(prompt));
    });

    it("copies the environment instead of aliasing it", () => {
      const env = { PATH: "/usr/bin" };
      const launch = adapter.launchCommand({ env });
      expect(launch.env).toEqual(env);
      expect(launch.env).not.toBe(env);
    });

    it("has an honest, harness-specific MCP install prompt", () => {
      const prompt = adapter.installMcpPrompt();
      expect(prompt).toContain("@sapiom/mcp");
      expect(prompt).toContain(installPromptMentions);
    });
  },
);
