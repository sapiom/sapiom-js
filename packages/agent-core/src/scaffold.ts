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
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentOperationError } from "./errors.js";

/**
 * Directory of this compiled module, resolved for BOTH build formats so the
 * bundled `templates/` resolves out of the box for CommonJS and ESM callers
 * alike (no explicit `templatesDir`/`SAPIOM_TEMPLATES_DIR` required):
 *   - CommonJS build → `__dirname` (a real global).
 *   - ESM build → derived from `import.meta.url` (there is no `__dirname`).
 *
 * `import.meta.url` is read via `eval` on purpose: this single source file is
 * also compiled under `module: commonjs`, where a literal `import.meta` is a hard
 * compile error (TS1343). Direct `eval` hides it from the compiler while still
 * resolving it at runtime inside the ESM module scope. Node-targeted only.
 */
function resolveModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  try {
    // eslint-disable-next-line no-eval
    const metaUrl = eval("import.meta.url") as string | undefined;
    if (typeof metaUrl === "string")
      return path.dirname(fileURLToPath(metaUrl));
  } catch {
    // Not an ESM runtime — fall through to the empty default.
  }
  return "";
}

const moduleDir: string = resolveModuleDir();

/**
 * Resolve the active templates directory. Priority: explicit `override` →
 * `SAPIOM_TEMPLATES_DIR` env → the bundled `templates/` two levels up from the
 * compiled module (available in the CommonJS build). Evaluated lazily so the
 * override can be set after module load.
 */
function getTemplatesDir(override?: string): string {
  return (
    override ??
    process.env.SAPIOM_TEMPLATES_DIR ??
    path.resolve(moduleDir, "..", "..", "templates")
  );
}

export const DEFAULT_TEMPLATE = "default";

const DOTFILE_NAMES = new Set(["_gitignore", "_npmrc"]);

// ── Version resolution ────────────────────────────────────────────────────────

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Offline fallbacks — bump alongside notable releases. */
const VERSION_FALLBACK = {
  orchestration: "0.1.1",
  tools: "0.1.1",
};

/** The zod major the authoring SDK is built against. */
const ZOD_VERSION = "4.1.12";

export interface ResolvedVersions {
  orchestration: string;
  tools: string;
  zod: string;
}

/**
 * The npm registry to resolve `latest` from, honoring the same config a plain
 * `npm install` would: a scoped `@<scope>:registry` wins over the global
 * `npm_config_registry`, which wins over the public default. Without this the
 * scaffold always pinned public-npm latest — so the local SDK dev loop (a
 * Verdaccio on :4873) could never scaffold a project onto a locally-published
 * patch, even with `npm_config_registry` set. See the workflows authoring guide §4.
 */
export function registryFor(pkg: string): string {
  const scope = pkg.startsWith("@") ? pkg.slice(0, pkg.indexOf("/")) : null;
  const scoped = scope
    ? process.env[`npm_config_${scope}:registry`]
    : undefined;
  const registry =
    scoped || process.env.npm_config_registry || DEFAULT_REGISTRY;
  return registry.replace(/\/+$/, "");
}

async function latestNpmVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${registryFor(pkg)}/${encodeURIComponent(pkg)}/latest`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return typeof json.version === "string" ? json.version : null;
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
  const [orchestration, tools] = await Promise.all([
    latestNpmVersion("@sapiom/agent"),
    latestNpmVersion("@sapiom/tools"),
  ]);
  return {
    orchestration: orchestration ?? VERSION_FALLBACK.orchestration,
    tools: tools ?? VERSION_FALLBACK.tools,
    zod: ZOD_VERSION,
  };
}

// ── Template helpers ──────────────────────────────────────────────────────────

export function listTemplates(templatesDir?: string): string[] {
  const root = getTemplatesDir(templatesDir);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) =>
    statSync(path.join(root, name)).isDirectory(),
  );
}

/** Absolute path to a bundled template directory. Throws on an unknown name. */
export function resolveTemplate(name: string, templatesDir?: string): string {
  const dir = path.join(getTemplatesDir(templatesDir), name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const available = listTemplates(templatesDir);
    throw new AgentOperationError({
      code: "UNKNOWN_TEMPLATE",
      message:
        `Unknown template '${name}'.` +
        (available.length
          ? ` Available: ${available.join(", ")}.`
          : " No templates are bundled."),
    });
  }
  return dir;
}

function applyReplacements(
  file: string,
  replacements: Record<string, string>,
): void {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
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

function copyTemplate(
  templateDir: string,
  targetDir: string,
  replacements: Record<string, string>,
): void {
  cpSync(templateDir, targetDir, { recursive: true });
  walk(targetDir, (file) => {
    const base = path.basename(file);
    // Restore dotfiles: _gitignore → .gitignore (npm strips literal .gitignore from published packages)
    if (DOTFILE_NAMES.has(base)) {
      const dotted = path.join(path.dirname(file), "." + base.slice(1));
      renameSync(file, dotted);
      applyReplacements(dotted, replacements);
      return;
    }
    applyReplacements(file, replacements);
  });
}

/**
 * Best-effort: initialize a git repository with a single commit so the project
 * is immediately deployable (`deploy` requires a repo with at least one commit).
 * Each scaffolded project is a self-contained, independently deployable unit, so
 * it always gets its own repo — including when scaffolded inside another repo (a
 * nested repo is the deployable unit). Never throws: if `git` is unavailable the
 * project is simply left uninitialized for the author to `git init` themselves.
 */
function initGitRepo(dir: string): boolean {
  const tryGit = (args: string[]): boolean => {
    try {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!tryGit(["init"])) return false;
  tryGit(["add", "-A"]);
  // Commit with the author's configured identity; fall back to a neutral one so
  // the initial commit (and therefore deploy) succeeds even with no git identity
  // configured. The `-c` flags apply only to this invocation.
  return (
    tryGit(["commit", "-m", "Initial commit"]) ||
    tryGit([
      "-c",
      "user.name=Sapiom",
      "-c",
      "user.email=noreply@sapiom.ai",
      "commit",
      "-m",
      "Initial commit",
    ])
  );
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
   * Directory holding the bundled templates. Required when calling from an ESM
   * context (no `__dirname`); a CommonJS caller can omit it (resolved relative
   * to the compiled module). Also overridable via `SAPIOM_TEMPLATES_DIR`.
   */
  templatesDir?: string;
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
  /** Whether a git repo with an initial commit was created (false if `git` was unavailable). */
  gitInitialized: boolean;
}

/**
 * Initialize a new orchestration project from a bundled template.
 *
 * Throws `AgentOperationError` (code `DIR_NOT_EMPTY` | `UNKNOWN_TEMPLATE`) on
 * precondition failures; all other errors propagate as-is.
 */
export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const { targetDir } = opts;
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const projectName = opts.projectName ?? path.basename(targetDir);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new AgentOperationError({
      code: "DIR_NOT_EMPTY",
      message: `Target directory '${targetDir}' already exists and is not empty.`,
    });
  }

  const templateDir = resolveTemplate(template, opts.templatesDir);
  const versions = opts.versions ?? (await resolveVersions());

  mkdirSync(targetDir, { recursive: true });
  copyTemplate(templateDir, targetDir, {
    __PROJECT_NAME__: projectName,
    __AGENT_VERSION__: versions.orchestration,
    __TOOLS_VERSION__: versions.tools,
    __ZOD_VERSION__: versions.zod,
  });

  // When versions were resolved from a non-default registry (a local Verdaccio
  // dev loop), the pinned @sapiom/* versions exist ONLY there — so point the
  // project's installs at the same registry, else `npm install` 404s against
  // public npm. Skipped for the default registry so a real customer's project
  // stays clean. Only meaningful when scaffold itself resolved the versions;
  // an explicit `opts.versions` caller manages its own registry.
  if (!opts.versions) {
    const sapiomRegistry = registryFor("@sapiom/tools");
    if (sapiomRegistry !== DEFAULT_REGISTRY) {
      writeFileSync(
        path.join(targetDir, ".npmrc"),
        `@sapiom:registry=${sapiomRegistry}\n`,
      );
    }
  }

  // Seed the committed stub file for the local-run loop. Created here (not
  // shipped in the template) so it doesn't depend on how the registry treats
  // dotfiles in a published package.
  const devDir = path.join(targetDir, ".sapiom-dev");
  mkdirSync(devDir, { recursive: true });
  writeFileSync(
    path.join(devDir, "stubs.json"),
    JSON.stringify({ version: 1, steps: {} }, null, 2) + "\n",
  );

  const gitInitialized = initGitRepo(targetDir);

  return { targetDir, template, projectName, gitInitialized };
}
