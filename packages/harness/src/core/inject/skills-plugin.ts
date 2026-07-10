/**
 * skills-plugin — generate a per-session --plugin-dir for Sapiom's bundled skills.
 *
 * claude-code auto-discovers `<plugin-dir>/skills/<name>/SKILL.md` when launched
 * with `--plugin-dir <path>`. A plugin-provided skill registers as a
 * PLUGIN-NAMESPACED slash command `/<plugin-name>:<name>` — NOT a bare
 * `/<name>` (verified against claude-code 2.1.x; bare names are reserved for
 * personal/project skills). The plugin name comes from plugin.json ("sapiom"
 * here), so the sapiom-agent-authoring skill surfaces as
 * `/sapiom:sapiom-agent-authoring`. The skill is also exposed to the agent's
 * model-driven Skill tool, so it can be auto-invoked by relevance without the
 * user typing the command at all.
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
import { readFileSync } from "node:fs";
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
 *
 * Two strategies, in order:
 *  1. Resolve the package's own package.json directly. Clean, but only works
 *     when agent-core's `exports` map exposes `./package.json` — older versions
 *     don't, and `require.resolve` then throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 *  2. Fallback: resolve the package's main entry (its `.` export, always
 *     defined) and walk up to the package root — the first ancestor whose
 *     package.json `name` is "@sapiom/agent-core". Robust to both the exports
 *     map and the dual dist layout (dist/esm, dist/cjs).
 *
 * Strategy 2 alone would suffice; strategy 1 is kept as the fast path for
 * agent-core versions that do expose ./package.json. The fallback is what keeps
 * a published harness working regardless of which agent-core version resolves
 * at install time — this exact seam silently no-op'd once (the skill never
 * loaded) precisely because only strategy 1 existed and its throw was swallowed.
 */
function resolveAgentCoreSkillsDir(): string | null {
  const require = createRequire(import.meta.url);

  // Strategy 1: direct package.json resolution (clean path).
  try {
    const pkgJsonPath = require.resolve("@sapiom/agent-core/package.json");
    return path.join(path.dirname(pkgJsonPath), "skills");
  } catch {
    // exports map may not expose ./package.json — fall through to strategy 2.
  }

  // Strategy 2: resolve the main entry and walk up to the package root.
  try {
    const entry = require.resolve("@sapiom/agent-core");
    let dir = path.dirname(entry);
    // Bounded climb: main entry (e.g. dist/esm/index.js) sits a handful of
    // levels below the package root; the guard prevents an unbounded walk to
    // the filesystem root if the layout is ever unexpected.
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
          name?: string;
        };
        if (pkg.name === "@sapiom/agent-core") return path.join(dir, "skills");
      } catch {
        // No package.json here (or unparseable / a nested type-marker without a
        // name field) — keep climbing.
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // agent-core not installed at all.
  }

  return null;
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
  // Plugin name is user-visible: it namespaces every skill's slash command as
  // `/<name>:<skill>`, so "sapiom" yields `/sapiom:sapiom-agent-authoring`.
  await fs.writeFile(
    path.join(pluginJsonDir, "plugin.json"),
    JSON.stringify({ name: "sapiom" }, null, 2) + "\n",
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
