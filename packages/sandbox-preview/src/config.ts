/**
 * `sapiom.json` — the project's committed declared intent. Sandbox previews live
 * under a name-keyed `resources` map, discriminated by `type`:
 *
 *   { "version": 1, "resources": { "web": { "type": "sandbox", "source": {...}, "start": "...", "port": 3000 } } }
 *
 * The map coexists with other capabilities' entries (e.g. an agent's `definitionId`)
 * — each capability owns only its own entries and never rewrites a sibling's. This
 * module reads/writes ONLY `type: "sandbox"` entries and validates them against the
 * capability-owned zod schema, so a malformed/hallucinated file fails with an
 * actionable message rather than a confusing downstream error.
 *
 * ENVELOPE vs RESOURCE: the `version` + `resources` envelope is the shared,
 * multi-surface part (see schema.ts) and is a candidate to extract into a shared
 * `@sapiom/project-config` once a second resources-map surface exists.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PreviewOperationError } from "./errors.js";
import {
  CONFIG_VERSION,
  storedSandboxSchema,
  type SandboxConfigBody,
} from "./schema.js";
import type { SandboxConfig } from "./types.js";

export const CONFIG_FILE = "sapiom.json";

interface SapiomFile {
  version?: number;
  host?: string;
  resources?: Record<string, { type?: string } & Record<string, unknown>>;
  [key: string]: unknown;
}

function readFile(dir: string): SapiomFile | null {
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  let parsed: SapiomFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as SapiomFile;
  } catch {
    throw new PreviewOperationError({
      code: "BAD_CONFIG",
      message: `${CONFIG_FILE} is not valid JSON.`,
    });
  }
  // Envelope version gate: an unversioned file is assumed current; a higher version
  // means the file was written by a newer tool than this one understands.
  if (typeof parsed.version === "number" && parsed.version > CONFIG_VERSION) {
    throw new PreviewOperationError({
      code: "UNSUPPORTED_CONFIG_VERSION",
      message: `${CONFIG_FILE} is version ${parsed.version}, but this tool supports up to ${CONFIG_VERSION}.`,
      hint: "Upgrade the Sapiom SDK/CLI.",
    });
  }
  return parsed;
}

/** Parse + validate one stored `type:"sandbox"` entry into a SandboxConfig (throws actionable on invalid). */
function parseSandboxEntry(
  name: string,
  entry: Record<string, unknown>,
): SandboxConfig {
  const result = storedSandboxSchema.safeParse(entry);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${["resources", name, ...i.path].join(".")}: ${i.message}`)
      .join("; ");
    throw new PreviewOperationError({
      code: "INVALID_SANDBOX",
      message: `Invalid sandbox resource "${name}" in ${CONFIG_FILE}.`,
      hint: detail,
    });
  }
  const { type: _type, ...body } = result.data;
  return { name, ...(body as SandboxConfigBody) };
}

/** Lexical on purpose, so a path is refused before the directory exists. */
export function sourcePathIssue(sub: string): string | undefined {
  if (path.isAbsolute(sub) || path.win32.isAbsolute(sub)) {
    return "must be a relative path inside the project directory, not an absolute path";
  }
  // Segment-based on purpose: resolving against a real base like `/` would let `../..` collapse onto it.
  const normalized = path.posix.normalize(sub.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    return "must stay inside the project directory";
  }
  return undefined;
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/** Why `sub` escapes the project, lexically or through a symlink; undefined when it stays inside. */
function sourceDirIssue(projectDir: string, sub: string): string | undefined {
  const lexical = sourcePathIssue(sub);
  if (lexical) return lexical;
  const root = path.resolve(projectDir);
  const sourceDir = path.resolve(root, sub);
  if (!isWithin(root, sourceDir))
    return "must stay inside the project directory";
  // Judge a missing folder by its nearest existing ancestor, so a link above it cannot escape once it appears.
  let existing = sourceDir;
  while (existing !== root && !existsSync(existing))
    existing = path.dirname(existing);
  if (
    existsSync(existing) &&
    !isWithin(realpathSync(root), realpathSync(existing))
  ) {
    return "resolves (through a symlink) outside the project directory";
  }
  return undefined;
}

/** Lexical and realpath checks so neither `../..` nor a symlinked source folder escapes the project. */
export function resolveSourceDir(
  projectDir: string,
  cfg: SandboxConfig,
): string {
  const sub = cfg.source.path ?? ".";
  const root = path.resolve(projectDir);
  const issue = sourceDirIssue(root, sub);
  if (issue) {
    throw new PreviewOperationError({
      code: "SOURCE_OUTSIDE_PROJECT",
      message: `source.path "${sub}" of sandbox "${cfg.name}" ${issue}.`,
      hint: `Set \`source.path\` on the "${cfg.name}" resource in ${CONFIG_FILE} to a folder inside ${root}.`,
    });
  }
  return path.resolve(root, sub);
}

/** All sandbox resources in the project, keyed by name (validated; empty object if none). */
export function readSandboxes(dir: string): Record<string, SandboxConfig> {
  const cfg = readFile(dir);
  const resources = cfg?.resources ?? {};
  const out: Record<string, SandboxConfig> = {};
  for (const [name, entry] of Object.entries(resources)) {
    if (entry?.type !== "sandbox") continue;
    out[name] = parseSandboxEntry(name, entry);
  }
  return out;
}

/**
 * Resolve a single sandbox to deploy. With a `name`, returns that one. Without,
 * returns the sole sandbox (singular-default) or throws if there are zero or many.
 */
export function getSandbox(dir: string, name?: string): SandboxConfig {
  const sandboxes = readSandboxes(dir);
  const names = Object.keys(sandboxes);

  if (name) {
    const found = sandboxes[name];
    if (!found) {
      throw new PreviewOperationError({
        code: "NO_SANDBOX",
        message: `No sandbox named '${name}' in ${CONFIG_FILE}.`,
        hint: names.length
          ? `Known sandboxes: ${names.join(", ")}.`
          : undefined,
      });
    }
    resolveSourceDir(dir, found);
    return found;
  }

  if (names.length === 0) {
    throw new PreviewOperationError({
      code: "NO_SANDBOX",
      message: `No sandbox resources defined in ${CONFIG_FILE}.`,
      hint: 'Add one with sapiom_dev_sandbox_configure (or a "type":"sandbox" resource).',
    });
  }
  if (names.length > 1) {
    throw new PreviewOperationError({
      code: "AMBIGUOUS_SANDBOX",
      message: `Multiple sandboxes defined (${names.join(", ")}); specify which one.`,
      hint: "Pass a name, e.g. `sapiom sandbox preview <name>`.",
    });
  }
  const only = sandboxes[names[0]];
  resolveSourceDir(dir, only);
  return only;
}

/**
 * Validate + persist a sandbox resource into `sapiom.json` (the `configure` core).
 * Validates the body against the schema (actionable errors), stamps the envelope
 * `version`, and merges into `resources` without clobbering siblings/top-level keys.
 */
export function configureSandbox(
  dir: string,
  name: string,
  body: SandboxConfigBody,
): SandboxConfig {
  const parsed = storedSandboxSchema.safeParse({ type: "sandbox", ...body });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new PreviewOperationError({
      code: "INVALID_SANDBOX",
      message: `Invalid sandbox configuration for "${name}".`,
      hint: detail,
    });
  }
  const pathIssue = sourceDirIssue(dir, body.source.path ?? ".");
  if (pathIssue) {
    throw new PreviewOperationError({
      code: "INVALID_SANDBOX",
      message: `Invalid sandbox configuration for "${name}".`,
      hint: `source.path: ${pathIssue}`,
    });
  }
  const existing = readFile(dir) ?? {};
  const next: SapiomFile = {
    version: CONFIG_VERSION,
    ...existing,
    resources: { ...(existing.resources ?? {}), [name]: parsed.data },
  };
  next.version = CONFIG_VERSION; // ensure current even if `existing` had an older/absent one
  writeFileSync(
    path.join(dir, CONFIG_FILE),
    JSON.stringify(next, null, 2) + "\n",
  );
  return { name, ...body };
}

/** Back-compat alias — `configureSandbox` is the validated writer. */
export const writeSandbox = (
  dir: string,
  cfg: SandboxConfig,
): SandboxConfig => {
  const { name, ...body } = cfg;
  return configureSandbox(dir, name, body);
};

/** Validate every sandbox resource without deploying (the `check` core). */
export function checkSandboxes(dir: string): {
  ok: boolean;
  sandboxes: string[];
  issues: string[];
} {
  const issues: string[] = [];
  const cfg = readFile(dir); // throws on bad JSON / unsupported version
  const resources = cfg?.resources ?? {};
  const found: string[] = [];
  for (const [name, entry] of Object.entries(resources)) {
    if (entry?.type !== "sandbox") continue;
    found.push(name);
    const r = storedSandboxSchema.safeParse(entry);
    if (!r.success) {
      for (const i of r.error.issues)
        issues.push(`resources.${name}.${i.path.join(".")}: ${i.message}`);
      continue;
    }
    const pathIssue = sourceDirIssue(dir, r.data.source.path ?? ".");
    if (pathIssue) issues.push(`resources.${name}.source.path: ${pathIssue}`);
  }
  return { ok: issues.length === 0, sandboxes: found, issues };
}
