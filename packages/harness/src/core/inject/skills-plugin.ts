/**
 * skills-plugin — generate a per-session --plugin-dir for Sapiom's bundled skills.
 *
 * claude-code auto-discovers `<plugin-dir>/skills/<name>/SKILL.md` and
 * registers `/<name>` as a slash command when launched with `--plugin-dir <path>`.
 * This module writes the required layout under a per-session subdirectory of
 * `generatedRoot` so sessions never share or race on config files.
 *
 * Source of skills: the installed @sapiom/agent-core package ships a `skills/`
 * directory alongside its dist. We resolve it via the package's own
 * package.json, then copy each `<name>/SKILL.md` into the plugin layout.
 *
 * The copy is session-scoped and non-mutating: nothing is written to the user's
 * own ~/.claude or the project repository. Retention (exit-time delete + sweep)
 * is handled by the same mechanism that cleans up mcp-config and settings files.
 *
 * Graceful no-op: if @sapiom/agent-core's skills directory is absent or
 * unresolvable, the function returns undefined rather than throwing — the
 * session still launches normally, just without the --plugin-dir flag.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";

import { HARNESS_PATHS } from "../../shared/types.js";
import { expandHome } from "../../cli/paths.js";

export interface SkillsPluginOptions {
  /** Root directory generated configs live under. Defaults to HARNESS_PATHS.generated. */
  generatedRoot?: string;
}

/**
 * Resolve the `skills/` directory from the installed @sapiom/agent-core package.
 * Returns null when the package or its skills directory is unresolvable.
 */
function resolveAgentCoreSkillsDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("@sapiom/agent-core/package.json");
    const pkgDir = path.dirname(pkgJsonPath);
    return path.join(pkgDir, "skills");
  } catch {
    return null;
  }
}

/**
 * Generate the per-session --plugin-dir for Sapiom's bundled skills.
 *
 * Creates:
 *   <generatedRoot>/<harnessSessionId>/skills-plugin/
 *     .claude-plugin/plugin.json
 *     skills/<name>/SKILL.md   (one entry per skill in agent-core's skills/)
 *
 * Returns the plugin dir path (`<generatedRoot>/<harnessSessionId>/skills-plugin`)
 * on success, or undefined when no skills are found or agent-core is not resolvable.
 */
export async function generateSkillsPlugin(
  harnessSessionId: string,
  options: SkillsPluginOptions = {},
): Promise<string | undefined> {
  const agentCoreSkillsDir = resolveAgentCoreSkillsDir();
  if (!agentCoreSkillsDir) return undefined;

  // Check the skills directory exists and has content.
  let skillDirs: string[];
  try {
    const entries = await fs.readdir(agentCoreSkillsDir, { withFileTypes: true });
    skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // skills/ directory absent or unreadable — graceful no-op.
    return undefined;
  }

  if (skillDirs.length === 0) return undefined;

  const generatedRoot = expandHome(options.generatedRoot ?? HARNESS_PATHS.generated);
  const pluginDir = path.join(generatedRoot, harnessSessionId, "skills-plugin");

  // Write the .claude-plugin/plugin.json manifest.
  const pluginJsonDir = path.join(pluginDir, ".claude-plugin");
  await fs.mkdir(pluginJsonDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginJsonDir, "plugin.json"),
    JSON.stringify({ name: "sapiom-harness-skills" }, null, 2) + "\n",
    "utf8",
  );

  // Copy each skill's SKILL.md into skills/<name>/SKILL.md.
  let copiedAny = false;
  for (const skillName of skillDirs) {
    const sourceMd = path.join(agentCoreSkillsDir, skillName, "SKILL.md");
    try {
      await fs.access(sourceMd);
    } catch {
      // No SKILL.md for this entry — skip.
      continue;
    }
    const destDir = path.join(pluginDir, "skills", skillName);
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(sourceMd, path.join(destDir, "SKILL.md"));
    copiedAny = true;
  }

  if (!copiedAny) return undefined;
  return pluginDir;
}
