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
 * The served platform rules (SAP-3225): the bundled `sapiom-agent-authoring`
 * skill carries only summaries of, and pointers to, the platform rules served
 * at `GET /v1/agents/authoring-rules`. While generating the plugin the session
 * fetches that body; on success its copy of the skill drops the summaries and
 * carries the served body in full, so a backend edit to the rules reaches a
 * Studio session on its next start without a package release. On any failure
 * the bundled copy is used unchanged. Either way the copy ends with a
 * `source: served|bundled · release … · digest …` line naming which it is.
 * Only the session copy changes; the installed package is never touched.
 *
 * Graceful no-op: if @sapiom/agent-core's skills directory is absent or
 * unresolvable, the function returns undefined rather than throwing — the
 * session still launches normally, just without the --plugin-dir flag.
 */

import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import {
  AUTHORING_RULES_PATH,
  parseAuthoringRulesStamp,
  type AuthoringRulesStamp,
} from "@sapiom/agent-core";
import {
  fetchServedContent,
  resolveEnvironment,
  servedContentFetchDisabled,
  validateStampedBody,
} from "@sapiom/mcp/auth";

import { HARNESS_PATHS } from "../../shared/types.js";
import { expandHome } from "../../cli/paths.js";
import { unpackedPath } from "../asar-path.js";

export interface SkillsPluginOptions {
  /** Root directory generated configs live under. Defaults to HARNESS_PATHS.generated. */
  generatedRoot?: string;
  /**
   * Sapiom environment whose API serves the platform rules. Defaults to
   * whatever `resolveEnvironment` picks (the credential store's current
   * environment, else production).
   */
  environment?: string;
}

/** The skill whose session copy carries the served platform rules. */
const AUTHORING_SKILL = "sapiom-agent-authoring";

/**
 * `1` or `true` skips the platform-rules fetch and keeps the bundled skill:
 * an escape hatch for an air-gapped run, and how the test suite keeps every
 * session-launching spec off the network (src/test-setup.ts).
 */
export const AUTHORING_RULES_FETCH_DISABLED_ENV =
  "SAPIOM_AUTHORING_RULES_FETCH_DISABLED";

/** The served platform rules, footer stripped, with the stamp they were served under. */
export interface ServedAuthoringRules {
  body: string;
  release: string;
  digest: string;
}

/**
 * Fetch the served platform rules for `environment`. `null` when disabled,
 * when the environment cannot be resolved, on any fetch failure, or when the
 * body does not carry a complete stamp it hashes to. Accepting the served copy
 * drops the bundled summaries, so a truncated or unstamped body must fall back
 * to the bundled skill rather than replace it. The serve-time footer is
 * stripped: the session copy states its own source.
 */
export async function fetchServedAuthoringRules(
  environment?: string,
): Promise<ServedAuthoringRules | null> {
  // Checked before environment resolution so a disabled run reads no file either.
  if (servedContentFetchDisabled(AUTHORING_RULES_FETCH_DISABLED_ENV)) return null;
  try {
    const served = await fetchServedContent(await resolveEnvironment(environment), {
      path: AUTHORING_RULES_PATH,
      disableEnv: AUTHORING_RULES_FETCH_DISABLED_ENV,
    });
    if (!served) return null;
    const stamped = validateStampedBody(served.body, served);
    if (!stamped) return null;
    return { body: stamped.canonical, release: stamped.release, digest: stamped.digest };
  } catch {
    return null;
  }
}

/** A bundled summary chapter: `<!-- section: NAME -->` through `<!-- /section: NAME -->`. */
const SUMMARY_SECTION = /<!-- section: ([a-z0-9-]+) -->[\s\S]*?<!-- \/section: \1 -->\n*/g;

/** The bundled copy's release stamp comment, with the blank lines after it. */
const STAMP_LINE = /<!--\s*sapiom-authoring-rules\b[^>]*-->\n*/;

/** Opening of the bundled intro paragraph that explains the summaries and the stamp. */
const SUMMARY_INTRO = "**Two kinds of content live here";

/** The intro that replaces {@link SUMMARY_INTRO} through the stamp in a served copy. */
const SERVED_INTRO =
  "**Two kinds of content live here.** The authoring _mechanics_ — the step model, directives, " +
  "`ctx.shared`, pause/resume, local stubs — describe the `@sapiom/agent` in your " +
  "`node_modules` and ship with it. The _platform rules_ — what is true of Sapiom regardless " +
  "of your SDK version — are inlined in full at the end of this skill, under " +
  "**Sapiom platform rules for agent authors**, as Sapiom served them when this session " +
  "started. Where anything above disagrees with them, the platform rules win.\n\n";

function sourceFooter(
  source: "served" | "bundled",
  stamp: { release: string | null; digest: string | null } | null,
): string {
  return `source: ${source} · release ${stamp?.release ?? "unknown"} · digest ${stamp?.digest ?? "unknown"}\n`;
}

/**
 * The session copy of the authoring skill when the rules were served: the
 * bundled summary chapters and the stamp removed, the intro reworded, and the
 * served body appended under its own `# Sapiom platform rules for agent
 * authors` heading, then the `source: served` footer.
 */
export function inlineServedAuthoringRules(
  bundled: string,
  served: ServedAuthoringRules,
): string {
  let skill = bundled;
  const stamp = STAMP_LINE.exec(skill);
  if (stamp) {
    const introStart = skill.lastIndexOf(`\n\n${SUMMARY_INTRO}`, stamp.index);
    skill =
      introStart === -1
        ? skill.slice(0, stamp.index) + skill.slice(stamp.index + stamp[0].length)
        : skill.slice(0, introStart + 2) +
          SERVED_INTRO +
          skill.slice(stamp.index + stamp[0].length);
  }
  skill = skill.replace(SUMMARY_SECTION, "");
  return `${skill.trimEnd()}\n\n${served.body}\n\n---\n\n${sourceFooter("served", served)}`;
}

/** The session copy of the authoring skill when the rules were not served: bundled, plus the footer. */
export function markBundledAuthoringRules(bundled: string): string {
  const stamp: AuthoringRulesStamp | null = parseAuthoringRulesStamp(bundled);
  return `${bundled.trimEnd()}\n\n---\n\n${sourceFooter("bundled", stamp)}`;
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

  // Strategy 1: direct package.json resolution (clean path). unpackedPath():
  // in the packaged desktop app require.resolve reports the app.asar virtual
  // path, and while readFile works there (Electron patches fs), copyFile's
  // SOURCE must be a real on-disk file — node_modules are asarUnpacked, so the
  // twin exists (harness CLAUDE.md's mandatory translation for any
  // package-relative path).
  try {
    const pkgJsonPath = require.resolve("@sapiom/agent-core/package.json");
    return unpackedPath(path.join(path.dirname(pkgJsonPath), "skills"));
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
        if (pkg.name === "@sapiom/agent-core") return unpackedPath(path.join(dir, "skills"));
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
 *     skills/<name>/SKILL.md   (one entry per skill in agent-core's skills/;
 *                               the authoring skill as described in the module comment)
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

  // Started before the writes so the request overlaps them; it never rejects.
  const servedRules = skillDirs.includes(AUTHORING_SKILL)
    ? fetchServedAuthoringRules(options.environment)
    : Promise.resolve(null);

  const generatedRoot = expandHome(options.generatedRoot ?? HARNESS_PATHS.generated);
  const pluginDir = path.join(generatedRoot, harnessSessionId, "skills-plugin");

  // The writes honor the module's documented graceful-no-op contract too:
  // this runs inside sessionManager.create()'s launch-opts phase, so an
  // unguarded mkdir/copy failure (disk, permissions, an asar edge we missed)
  // killed the whole session over an optional skills plugin.
  try {
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
      if (skillName === AUTHORING_SKILL) {
        const bundled = await fs.readFile(sourceMd, "utf8");
        const served = await servedRules;
        await fs.writeFile(
          path.join(destDir, "SKILL.md"),
          served
            ? inlineServedAuthoringRules(bundled, served)
            : markBundledAuthoringRules(bundled),
          "utf8",
        );
      } else {
        await fs.copyFile(sourceMd, path.join(destDir, "SKILL.md"));
      }
      copiedAny = true;
    }

    if (!copiedAny) return undefined;
    return pluginDir;
  } catch (err) {
    console.warn(
      `[harness] skills-plugin generation failed for session ${harnessSessionId} — launching without --plugin-dir:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}
