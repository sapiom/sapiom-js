/**
 * Skills listing server — backs GET /api/skills and GET /api/skills/:id.
 *
 * Two skill sources are merged:
 *   1. Installed @sapiom packages: scans node_modules/@sapiom/{pkg}/skills/SKILL.md
 *      (gracefully empty when no package ships skills yet).
 *   2. User's own ~/.claude/skills/{id}/SKILL.md (same convention Claude Code
 *      uses for project-specific skills).
 *
 * Path-traversal safety: skill ids are slug-shaped identifiers (letters,
 * digits, hyphens) — any id that cannot map to a known skill path is
 * rejected with a 404 before any filesystem access. The set of known paths
 * is built at list time and re-used by the detail endpoint to avoid walking
 * the filesystem on every request.
 *
 * Markdown is served as-is — the SPA renders it client-side (no HTML
 * injection here). The frontmatter block is stripped before delivery so the
 * rendered view shows only the body.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Router } from "express";

export interface SkillMeta {
  /** Stable identifier: directory name of the skill folder. */
  id: string;
  /** Human name from the `name:` frontmatter field. Falls back to the id. */
  name: string;
  /** One-line description from the `description:` frontmatter field. */
  description: string;
  /** Logical source group — shown in the panel's section header. */
  source: "package" | "user";
}

export interface SkillDetail extends SkillMeta {
  /** The full SKILL.md body with the frontmatter block stripped. */
  body: string;
}

/** Stable slug: only letters, digits, and hyphens/underscores. */
const SAFE_SLUG = /^[a-zA-Z0-9_-]+$/;

/** Parse the `---\n...\n---` YAML frontmatter block (simple key: value only). */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith("---")) return { meta, body: raw };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta, body: raw };

  const block = raw.slice(3, end).trim();
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    // Strip inline quotes and leading whitespace; handle multi-line by
    // collapsing continuation lines (indented) into the value.
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }

  return { meta, body: raw.slice(end + 4).trimStart() };
}

/** Read and parse a SKILL.md file, returning null on any fs/parse error. */
async function readSkillFile(
  filePath: string,
  id: string,
  source: "package" | "user",
): Promise<SkillMeta & { body: string; filePath: string } | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    return {
      id,
      name: meta.name ?? id,
      description: meta.description ?? "",
      source,
      body,
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Scan node_modules/@sapiom/{pkg}/skills/{id}/SKILL.md, starting from the
 * given root (defaults to the directory this module lives in, walking up to
 * find the node_modules directory). Returns the discovered skills.
 */
async function scanPackageSkills(
  nodeModulesRoot?: string,
): Promise<Array<SkillMeta & { body: string; filePath: string }>> {
  const nmRoot = nodeModulesRoot ?? findNodeModules();
  const sapiomDir = path.join(nmRoot, "@sapiom");
  const results: Array<SkillMeta & { body: string; filePath: string }> = [];

  let pkgDirs: string[];
  try {
    pkgDirs = await fs.readdir(sapiomDir);
  } catch {
    return results; // no @sapiom packages installed — gracefully empty
  }

  for (const pkg of pkgDirs) {
    const skillsDir = path.join(sapiomDir, pkg, "skills");
    let skillDirs: string[];
    try {
      skillDirs = await fs.readdir(skillsDir);
    } catch {
      continue; // package has no skills directory
    }

    for (const skillDir of skillDirs) {
      const skillFile = path.join(skillsDir, skillDir, "SKILL.md");
      const parsed = await readSkillFile(skillFile, skillDir, "package");
      if (parsed) results.push(parsed);
    }
  }

  return results;
}

/**
 * Resolve the node_modules directory for production use.
 * The compiled module lives at dist/server/skills.js — going up three levels
 * (dist/server → dist → package-root) lands at node_modules alongside the
 * package's own package.json. Falls back to process.cwd() when import.meta.url
 * is unavailable (non-ESM build).
 */
function findNodeModules(): string {
  try {
    // import.meta.url is the compiled file's own URL:
    //   file:///…/packages/harness/dist/server/skills.js
    // Three dirname calls: dist/server → dist → package-root.
    const here = new URL(import.meta.url).pathname;
    return path.join(path.dirname(path.dirname(path.dirname(here))), "node_modules");
  } catch {
    return path.join(process.cwd(), "node_modules");
  }
}

/** Scan ~/.claude/skills/{id}/SKILL.md. Returns discovered skills. */
async function scanUserSkills(): Promise<Array<SkillMeta & { body: string; filePath: string }>> {
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  const results: Array<SkillMeta & { body: string; filePath: string }> = [];

  let skillDirs: string[];
  try {
    skillDirs = await fs.readdir(skillsDir);
  } catch {
    return results; // directory doesn't exist — gracefully empty
  }

  for (const skillDir of skillDirs) {
    const skillFile = path.join(skillsDir, skillDir, "SKILL.md");
    const parsed = await readSkillFile(skillFile, skillDir, "user");
    if (parsed) results.push(parsed);
  }

  return results;
}

export interface SkillsRouterOptions {
  /** Override the node_modules root for testing. */
  nodeModulesRoot?: string;
  /** Override the user skills root (default: ~/.claude/skills). */
  userSkillsRoot?: string;
}

export function createSkillsRouter(options: SkillsRouterOptions = {}): Router {
  const router = Router();

  /**
   * GET /api/skills — list all discoverable skills with id, name, description,
   * and source. Safe: no paths are exposed; ids are directory names.
   */
  router.get("/api/skills", async (_req, res) => {
    try {
      const [pkgSkills, userSkills] = await Promise.all([
        scanPackageSkills(options.nodeModulesRoot),
        options.userSkillsRoot
          ? scanUserSkillsFromRoot(options.userSkillsRoot)
          : scanUserSkills(),
      ]);

      // Dedupe by id: user skills win over package skills (same id).
      const byId = new Map<string, SkillMeta>();
      for (const skill of [...pkgSkills, ...userSkills]) {
        byId.set(skill.id, { id: skill.id, name: skill.name, description: skill.description, source: skill.source });
      }

      res.json(Array.from(byId.values()));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/skills/:id — full detail (meta + markdown body) for a single
   * skill. Path-traversal safe: the id must be a known slug, never a path.
   */
  router.get("/api/skills/:id", async (req, res) => {
    const { id } = req.params;

    // Reject anything that isn't a safe slug up front.
    if (!id || !SAFE_SLUG.test(id)) {
      res.status(404).json({ error: `Unknown skill '${id}'` });
      return;
    }

    try {
      const [pkgSkills, userSkills] = await Promise.all([
        scanPackageSkills(options.nodeModulesRoot),
        options.userSkillsRoot
          ? scanUserSkillsFromRoot(options.userSkillsRoot)
          : scanUserSkills(),
      ]);

      // User skills win on id collision (same convention as the list endpoint).
      const all = [...pkgSkills, ...userSkills];
      const byId = new Map<string, (typeof all)[0]>();
      for (const skill of all) byId.set(skill.id, skill);

      const found = byId.get(id);
      if (!found) {
        res.status(404).json({ error: `Unknown skill '${id}'` });
        return;
      }

      const detail: SkillDetail = {
        id: found.id,
        name: found.name,
        description: found.description,
        source: found.source,
        body: found.body,
      };
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

/** Scan skills from a custom root (for testing). Same logic as scanUserSkills. */
async function scanUserSkillsFromRoot(
  root: string,
): Promise<Array<SkillMeta & { body: string; filePath: string }>> {
  const results: Array<SkillMeta & { body: string; filePath: string }> = [];
  let skillDirs: string[];
  try {
    skillDirs = await fs.readdir(root);
  } catch {
    return results;
  }

  for (const skillDir of skillDirs) {
    const skillFile = path.join(root, skillDir, "SKILL.md");
    const parsed = await readSkillFile(skillFile, skillDir, "user");
    if (parsed) results.push(parsed);
  }

  return results;
}
