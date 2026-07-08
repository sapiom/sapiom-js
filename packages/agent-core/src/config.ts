/**
 * `sapiom.json` — committed, team-shared project identity (which server-side
 * agent this repo deploys to). The server is the source of truth; this
 * file is a re-resolvable cache that `link` can rewrite. The API key is never
 * stored here — it comes from the environment or the caller.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AgentOperationError } from './errors.js';

export const CONFIG_FILE = 'sapiom.json';

export interface SapiomConfig {
  /**
   * Server-side definition id. Absent right after a template `clone` (the
   * definition is created at `deploy`, D6) and filled in by `link`; `deploy`/
   * `run` require it (see {@link requireConfig}).
   */
  definitionId?: string;
  /** Agent name, cached by `link` (matches `defineAgent({ name })`). */
  name?: string;
  host?: string;
  /**
   * Template-clone provenance (SAP-1357). Written by `sapiom_dev_agents_clone`
   * when a fork is materialized locally so the project records where it came from
   * before it is linked/deployed. Never carries a credential.
   */
  templateId?: string;
  /** Fork record id (`github_user_repos.id`) — re-mint a clone token against it. */
  forkId?: string;
  /** Full repo name `owner/repo` of the per-fork repo. */
  repoFullName?: string;
  /** Default branch of the per-fork repo. */
  defaultBranch?: string;
}

export function readConfig(dir: string): SapiomConfig | null {
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SapiomConfig;
  } catch {
    throw new AgentOperationError({ code: 'BAD_CONFIG', message: `${CONFIG_FILE} is not valid JSON.` });
  }
}

/** A config known to be linked: `definitionId` is guaranteed present. */
export type LinkedSapiomConfig = SapiomConfig & { definitionId: string };

export function requireConfig(dir: string): LinkedSapiomConfig {
  const cfg = readConfig(dir);
  if (!cfg?.definitionId) {
    throw new AgentOperationError({
      code: 'NOT_LINKED',
      message: 'This project is not linked to a Sapiom agent.',
      hint: 'Run: sapiom agents link <name>',
    });
  }
  return cfg as LinkedSapiomConfig;
}

/**
 * Write `sapiom.json`, merging over any existing config rather than replacing it.
 * The file is a re-resolvable cache with several independent authors — `clone`
 * writes fork provenance, `link` later writes `{ definitionId, name }` — and a
 * merge keeps each write from clobbering fields it does not own (so a `link`
 * after a `clone` preserves the fork provenance).
 */
export function writeConfig(dir: string, cfg: SapiomConfig): void {
  const existing = readConfig(dir) ?? {};
  const merged = { ...existing, ...cfg };
  writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(merged, null, 2) + '\n');
}
