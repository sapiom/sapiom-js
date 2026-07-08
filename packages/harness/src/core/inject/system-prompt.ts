/**
 * Writes the per-session system-prompt file the claude-code adapter reads
 * and inlines via `--append-system-prompt` (see LaunchOpts.systemPromptFile
 * — the adapter wants file contents, not the profile text itself, so the
 * server layer materializes it once per session here).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { HARNESS_PATHS } from "../../shared/types.js";
import { expandHome } from "../paths.js";
import { DEFAULT_SYSTEM_PROMPT } from "../../profiles/default.js";

export interface GenerateSystemPromptFileOptions {
  /** Root directory generated configs live under. Defaults to
   *  HARNESS_PATHS.generated. Override in tests to avoid the real home dir. */
  generatedRoot?: string;
  /** Defaults to the harness's default profile (DEFAULT_SYSTEM_PROMPT). */
  prompt?: string;
}

/** Writes `<generated>/<harnessSessionId>/system-prompt.txt`. Returns its
 *  absolute path (LaunchOpts.systemPromptFile). */
export async function generateSystemPromptFile(
  harnessSessionId: string,
  options: GenerateSystemPromptFileOptions = {},
): Promise<string> {
  const root = expandHome(options.generatedRoot ?? HARNESS_PATHS.generated);
  const dir = path.join(root, harnessSessionId);
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, "system-prompt.txt");
  await fs.writeFile(filePath, options.prompt ?? DEFAULT_SYSTEM_PROMPT, "utf8");
  return filePath;
}
