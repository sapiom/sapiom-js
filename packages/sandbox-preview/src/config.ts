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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PreviewOperationError } from './errors.js';
import { CONFIG_VERSION, storedSandboxSchema, type SandboxConfigBody } from './schema.js';
import type { SandboxConfig } from './types.js';

export const CONFIG_FILE = 'sapiom.json';

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
    parsed = JSON.parse(readFileSync(file, 'utf8')) as SapiomFile;
  } catch {
    throw new PreviewOperationError({ code: 'BAD_CONFIG', message: `${CONFIG_FILE} is not valid JSON.` });
  }
  // Envelope version gate: an unversioned file is assumed current; a higher version
  // means the file was written by a newer tool than this one understands.
  if (typeof parsed.version === 'number' && parsed.version > CONFIG_VERSION) {
    throw new PreviewOperationError({
      code: 'UNSUPPORTED_CONFIG_VERSION',
      message: `${CONFIG_FILE} is version ${parsed.version}, but this tool supports up to ${CONFIG_VERSION}.`,
      hint: 'Upgrade the Sapiom SDK/CLI.',
    });
  }
  return parsed;
}

/** Parse + validate one stored `type:"sandbox"` entry into a SandboxConfig (throws actionable on invalid). */
function parseSandboxEntry(name: string, entry: Record<string, unknown>): SandboxConfig {
  const result = storedSandboxSchema.safeParse(entry);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${['resources', name, ...i.path].join('.')}: ${i.message}`)
      .join('; ');
    throw new PreviewOperationError({
      code: 'INVALID_SANDBOX',
      message: `Invalid sandbox resource "${name}" in ${CONFIG_FILE}.`,
      hint: detail,
    });
  }
  const { type: _type, ...body } = result.data;
  return { name, ...(body as SandboxConfigBody) };
}

/** All sandbox resources in the project, keyed by name (validated; empty object if none). */
export function readSandboxes(dir: string): Record<string, SandboxConfig> {
  const cfg = readFile(dir);
  const resources = cfg?.resources ?? {};
  const out: Record<string, SandboxConfig> = {};
  for (const [name, entry] of Object.entries(resources)) {
    if (entry?.type !== 'sandbox') continue;
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
        code: 'NO_SANDBOX',
        message: `No sandbox named '${name}' in ${CONFIG_FILE}.`,
        hint: names.length ? `Known sandboxes: ${names.join(', ')}.` : undefined,
      });
    }
    return found;
  }

  if (names.length === 0) {
    throw new PreviewOperationError({
      code: 'NO_SANDBOX',
      message: `No sandbox resources defined in ${CONFIG_FILE}.`,
      hint: 'Add one with sapiom_dev_sandbox_configure (or a "type":"sandbox" resource).',
    });
  }
  if (names.length > 1) {
    throw new PreviewOperationError({
      code: 'AMBIGUOUS_SANDBOX',
      message: `Multiple sandboxes defined (${names.join(', ')}); specify which one.`,
      hint: 'Pass a name, e.g. `sapiom sandbox preview <name>`.',
    });
  }
  return sandboxes[names[0]];
}

/**
 * Validate + persist a sandbox resource into `sapiom.json` (the `configure` core).
 * Validates the body against the schema (actionable errors), stamps the envelope
 * `version`, and merges into `resources` without clobbering siblings/top-level keys.
 */
export function configureSandbox(dir: string, name: string, body: SandboxConfigBody): SandboxConfig {
  const parsed = storedSandboxSchema.safeParse({ type: 'sandbox', ...body });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new PreviewOperationError({
      code: 'INVALID_SANDBOX',
      message: `Invalid sandbox configuration for "${name}".`,
      hint: detail,
    });
  }
  const existing = readFile(dir) ?? {};
  const next: SapiomFile = {
    version: CONFIG_VERSION,
    ...existing,
    resources: { ...(existing.resources ?? {}), [name]: parsed.data },
  };
  next.version = CONFIG_VERSION; // ensure current even if `existing` had an older/absent one
  writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(next, null, 2) + '\n');
  return { name, ...body };
}

/** Back-compat alias — `configureSandbox` is the validated writer. */
export const writeSandbox = (dir: string, cfg: SandboxConfig): SandboxConfig => {
  const { name, ...body } = cfg;
  return configureSandbox(dir, name, body);
};

/** Validate every sandbox resource without deploying (the `check` core). */
export function checkSandboxes(dir: string): { ok: boolean; sandboxes: string[]; issues: string[] } {
  const issues: string[] = [];
  const cfg = readFile(dir); // throws on bad JSON / unsupported version
  const resources = cfg?.resources ?? {};
  const found: string[] = [];
  for (const [name, entry] of Object.entries(resources)) {
    if (entry?.type !== 'sandbox') continue;
    found.push(name);
    const r = storedSandboxSchema.safeParse(entry);
    if (!r.success) {
      for (const i of r.error.issues) issues.push(`resources.${name}.${i.path.join('.')}: ${i.message}`);
    }
  }
  return { ok: issues.length === 0, sandboxes: found, issues };
}
