/**
 * `sapiom.json` — committed, team-shared project identity (which server-side
 * orchestration this repo deploys to). The server is the source of truth; this
 * file is a re-resolvable cache that `link` can rewrite. The API key is never
 * stored here — it comes from the environment.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CliError } from './output.js';

export const CONFIG_FILE = 'sapiom.json';

export interface SapiomConfig {
  definitionId: string;
  name: string;
  host?: string;
}

export function readConfig(dir: string): SapiomConfig | null {
  const file = path.join(dir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SapiomConfig;
  } catch {
    throw new CliError({ code: 'BAD_CONFIG', message: `${CONFIG_FILE} is not valid JSON.` });
  }
}

export function requireConfig(dir: string): SapiomConfig {
  const cfg = readConfig(dir);
  if (!cfg?.definitionId) {
    throw new CliError({
      code: 'NOT_LINKED',
      message: 'This project is not linked to a Sapiom orchestration.',
      hint: 'Run: sapiom orchestrations link <name>',
    });
  }
  return cfg;
}

export function writeConfig(dir: string, cfg: SapiomConfig): void {
  writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n');
}
