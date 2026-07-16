/**
 * Real launch-opts wiring: generates the per-session --settings, --mcp-config,
 * and --append-system-prompt source files. Generated uniformly for every
 * harness kind — an adapter that doesn't use one of these fields (codex,
 * today) simply ignores it, same as the claude-code adapter already does for
 * whichever of the three a given launch doesn't set. `apiKey` (from CLI auth,
 * null when unauthenticated / --no-auth) flows into the generated mcp-config
 * so the remote `sapiom` MCP is actually authenticated — a factory rather
 * than a plain function since it's per-caller-instance state.
 *
 * Extracted from server/index.ts so the CLI passthrough mode (cli/passthrough.ts)
 * can generate the exact same per-session inject files without booting the
 * web server. The server keeps its pendingGeneratedRemovals serialization
 * wrapper locally — that's a SessionManager-lifecycle concern, not a
 * generation concern.
 */

import type { LaunchOptsBuilder } from "../session-manager.js";
import { generateClaudeSettings } from "./claude-settings.js";
import { generateMcpConfig } from "./mcp-config.js";
import { generateSystemPromptFile } from "./system-prompt.js";
import { generateSkillsPlugin } from "./skills-plugin.js";

export interface DefaultBuildLaunchOptsOptions {
  /** Root directory generated configs live under. Defaults to
   *  HARNESS_PATHS.generated. Override in tests to avoid the real home dir. */
  generatedRoot?: string;
  /** System prompt text to materialize. Defaults to DEFAULT_SYSTEM_PROMPT
   *  (see generateSystemPromptFile) — CLI passthrough mode passes
   *  CLI_SYSTEM_PROMPT instead. */
  systemPrompt?: string;
}

export function createDefaultBuildLaunchOpts(
  apiKey: string | null,
  options: DefaultBuildLaunchOptsOptions = {},
): LaunchOptsBuilder {
  const { generatedRoot, systemPrompt } = options;
  return async (harnessSessionId) => {
    const [settings, mcpConfigFile, systemPromptFile, pluginDir] = await Promise.all([
      generateClaudeSettings({ harnessSessionId, generatedRoot }),
      generateMcpConfig(harnessSessionId, { environment: process.env.SAPIOM_ENVIRONMENT, apiKey, generatedRoot }),
      generateSystemPromptFile(harnessSessionId, {
        generatedRoot,
        ...(systemPrompt !== undefined ? { prompt: systemPrompt } : {}),
      }),
      generateSkillsPlugin(harnessSessionId, { generatedRoot }),
    ]);
    return {
      settingsFile: settings.settingsPath,
      mcpConfigFile,
      systemPromptFile,
      ...(pluginDir ? { pluginDir } : {}),
    };
  };
}
