/**
 * `sapiom.json` — the project's committed declared intent. Sandbox previews live
 * under a name-keyed `resources` map, discriminated by `type`:
 *
 *   { "resources": { "web": { "type": "sandbox", "source": {...}, "start": "...", "port": 3000 } } }
 *
 * The map coexists with other capabilities' top-level keys (e.g. an agent's
 * `definitionId`) — each capability owns only its own entries and never rewrites
 * a sibling's. This module reads/writes ONLY `type: "sandbox"` entries.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PreviewOperationError } from './errors.js';
import type { SandboxConfig } from './types.js';

export const CONFIG_FILE = 'sapiom.json';

/** Stored sandbox entry — the on-disk shape (name is the map key, not a field). */
type StoredSandbox = Omit<SandboxConfig, 'name'> & { type: 'sandbox' };

interface SapiomFile {
  host?: string;
  resources?: Record<string, { type?: string } & Record<string, unknown>>;
  [key: string]: unknown;
}

function readFile(dir: string): SapiomFile | null {
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SapiomFile;
  } catch {
    throw new PreviewOperationError({
      code: 'BAD_CONFIG',
      message: `${CONFIG_FILE} is not valid JSON.`,
    });
  }
}

/** All sandbox resources in the project, keyed by name (empty object if none). */
export function readSandboxes(dir: string): Record<string, SandboxConfig> {
  const cfg = readFile(dir);
  const resources = cfg?.resources ?? {};
  const out: Record<string, SandboxConfig> = {};
  for (const [name, entry] of Object.entries(resources)) {
    if (entry?.type !== 'sandbox') continue;
    const { type: _type, ...rest } = entry as StoredSandbox;
    out[name] = { name, ...(rest as Omit<SandboxConfig, 'name'>) };
  }
  return out;
}

/**
 * Resolve a single sandbox to deploy. With a `name`, returns that one. Without,
 * returns the sole sandbox (singular-default) or throws if there are zero or many
 * — so the common one-app project needs no `--name`.
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
      hint: 'Add a resource with "type": "sandbox" (source, start, port).',
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
 * Persist a sandbox resource into `sapiom.json`, merging into the `resources` map
 * without clobbering sibling entries or other top-level keys.
 */
export function writeSandbox(dir: string, cfg: SandboxConfig): void {
  const existing = readFile(dir) ?? {};
  const { name, ...rest } = cfg;
  const entry: StoredSandbox = { type: 'sandbox', ...rest };
  const next: SapiomFile = {
    ...existing,
    resources: { ...(existing.resources ?? {}), [name]: entry },
  };
  writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(next, null, 2) + '\n');
}
