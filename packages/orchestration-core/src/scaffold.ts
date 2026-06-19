/**
 * scaffold — initialize a new orchestration project from a bundled template.
 *
 * Pure local operation: no network, no process.env. All inputs are passed
 * explicitly; the caller is responsible for output rendering.
 *
 * Template resolution: the `templates/` directory ships alongside `dist/` in
 * the published package. The resolution seam is deliberately isolated here so
 * remote-fetch or richer template registries can slot in without touching the
 * function signature.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { OrchestrationError } from './errors.js';

/**
 * Where bundled templates live relative to this file after compilation.
 *
 * The compiled output lives at dist/cjs/scaffold.js or dist/esm/scaffold.js;
 * templates/ is two levels up at the package root.
 *
 * `__dirname` is available in CJS; in ESM TypeScript's `importHelpers` or an
 * explicit shim can provide it. We also accept an env override
 * (SAPIOM_getTemplatesDir()) for tests that need to point at a fixture directory.
 *
 * eslint-disable-next-line @typescript-eslint/no-explicit-any
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const _dirname: string = typeof __dirname !== 'undefined' ? __dirname : (globalThis as any).__dirname ?? '';

/**
 * Return the active templates directory. Evaluated lazily so the
 * SAPIOM_TEMPLATES_DIR override (used in tests) can be set after module load.
 */
function getTemplatesDir(): string {
  return process.env.SAPIOM_TEMPLATES_DIR ?? path.resolve(_dirname, '..', '..', 'templates');
}

export const DEFAULT_TEMPLATE = 'default';

const DOTFILE_NAMES = new Set(['_gitignore', '_npmrc']);

// ── Version resolution ────────────────────────────────────────────────────────

const REGISTRY = 'https://registry.npmjs.org';

/** Offline fallbacks — bump alongside notable releases. */
const VERSION_FALLBACK = {
  orchestration: '0.1.1',
  tools: '0.1.1',
  cli: '0.1.0',
};

/** Pinned to the zod 3.25.x line the SDK requires. */
const ZOD_VERSION = '3.25.76';

export interface ResolvedVersions {
  orchestration: string;
  tools: string;
  zod: string;
  cli: string;
}

async function latestNpmVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`${REGISTRY}/${pkg.replace('/', '%2F')}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the @sapiom/* dependency versions to stamp into a scaffolded project.
 * Fetches the current npm latest with a 5 s timeout; falls back to pinned
 * constants if the registry is unreachable.
 */
export async function resolveVersions(): Promise<ResolvedVersions> {
  const [orchestration, tools, cli] = await Promise.all([
    latestNpmVersion('@sapiom/orchestration'),
    latestNpmVersion('@sapiom/tools'),
    latestNpmVersion('@sapiom/cli'),
  ]);
  return {
    orchestration: orchestration ?? VERSION_FALLBACK.orchestration,
    tools: tools ?? VERSION_FALLBACK.tools,
    zod: ZOD_VERSION,
    cli: cli ?? VERSION_FALLBACK.cli,
  };
}

// ── Template helpers ──────────────────────────────────────────────────────────

export function listTemplates(): string[] {
  if (!existsSync(getTemplatesDir())) return [];
  return readdirSync(getTemplatesDir()).filter((name) => statSync(path.join(getTemplatesDir(), name)).isDirectory());
}

/** Absolute path to a bundled template directory. Throws on an unknown name. */
export function resolveTemplate(name: string): string {
  const dir = path.join(getTemplatesDir(), name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const available = listTemplates();
    throw new OrchestrationError({
      code: 'UNKNOWN_TEMPLATE',
      message:
        `Unknown template '${name}'.` +
        (available.length ? ` Available: ${available.join(', ')}.` : ' No templates are bundled.'),
    });
  }
  return dir;
}

function applyReplacements(file: string, replacements: Record<string, string>): void {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return; // unreadable / binary — leave as-is
  }
  let changed = false;
  for (const [token, value] of Object.entries(replacements)) {
    if (content.includes(token)) {
      content = content.split(token).join(value);
      changed = true;
    }
  }
  if (changed) writeFileSync(file, content);
}

function walk(dir: string, onFile: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

function copyTemplate(templateDir: string, targetDir: string, replacements: Record<string, string>): void {
  cpSync(templateDir, targetDir, { recursive: true });
  walk(targetDir, (file) => {
    const base = path.basename(file);
    // Restore dotfiles: _gitignore → .gitignore (npm strips literal .gitignore from published packages)
    if (DOTFILE_NAMES.has(base)) {
      const dotted = path.join(path.dirname(file), '.' + base.slice(1));
      renameSync(file, dotted);
      applyReplacements(dotted, replacements);
      return;
    }
    applyReplacements(file, replacements);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ScaffoldOptions {
  /** Target directory for the new project. Must be absolute. */
  targetDir: string;
  /** Template name (defaults to 'default'). */
  template?: string;
  /** Project name stamped into templates as __PROJECT_NAME__. */
  projectName?: string;
  /**
   * Pre-resolved dependency versions. If omitted, `scaffold` fetches them from
   * the npm registry (may add ~5 s on slow connections).
   */
  versions?: ResolvedVersions;
}

export interface ScaffoldResult {
  targetDir: string;
  template: string;
  projectName: string;
}

/**
 * Initialize a new orchestration project from a bundled template.
 *
 * Throws `OrchestrationError` (code `DIR_NOT_EMPTY` | `UNKNOWN_TEMPLATE`) on
 * precondition failures; all other errors propagate as-is.
 */
export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const { targetDir } = opts;
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const projectName = opts.projectName ?? path.basename(targetDir);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new OrchestrationError({
      code: 'DIR_NOT_EMPTY',
      message: `Target directory '${targetDir}' already exists and is not empty.`,
    });
  }

  const templateDir = resolveTemplate(template);
  const versions = opts.versions ?? (await resolveVersions());

  mkdirSync(targetDir, { recursive: true });
  copyTemplate(templateDir, targetDir, {
    __PROJECT_NAME__: projectName,
    __ORCHESTRATION_VERSION__: versions.orchestration,
    __TOOLS_VERSION__: versions.tools,
    __ZOD_VERSION__: versions.zod,
    __CLI_VERSION__: versions.cli,
  });

  return { targetDir, template, projectName };
}
