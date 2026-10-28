/**
 * Machine-level CLI configuration persisted at `~/.sapiom/config.json`. Stores
 * the active target (prod / staging / local) and any user-set host override.
 * Project identity (`sapiom.json` / `definitionId`) is kept separate from this —
 * the server stays the source of truth for what agents exist.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';

import { configDir, configFilePath } from './paths.js';

export type CliTarget = 'prod' | 'staging' | 'local';

export interface CliConfig {
  /**
   * Named target: `prod` routes to the production backend, `staging` to the
   * staging backend (`api.sapiom.dev`), `local` to the backend running on
   * localhost:3000. A raw `host` override supersedes this.
   */
  target?: CliTarget;
  /**
   * Explicit host URL override. When present, takes precedence over `target`.
   * Stored so `sapiom agents run` remembers the host without requiring
   * `--host` on every invocation.
   */
  host?: string;
}

const PROD_HOST = 'https://api.sapiom.ai';
const STAGING_HOST = 'https://api.sapiom.dev';
const LOCAL_HOST = 'http://localhost:3000';

/** The API host a named target routes to. */
export function hostForTarget(target: CliTarget): string {
  switch (target) {
    case 'local':
      return LOCAL_HOST;
    case 'staging':
      return STAGING_HOST;
    default:
      return PROD_HOST;
  }
}

function load(): CliConfig {
  const file = configFilePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

function persist(cfg: CliConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2) + '\n');
}

export function readCliConfig(): CliConfig {
  return load();
}

export function writeCliConfig(patch: Partial<CliConfig>): void {
  const current = load();
  persist({ ...current, ...patch });
}

/**
 * Committed project config can come from an untrusted template, so it must
 * never choose the host that receives the API key.
 */
export function resolveHost(opts: { flagHost?: string; flagTarget?: CliTarget }): string {
  // Env var always wins
  if (process.env.SAPIOM_HOST) return process.env.SAPIOM_HOST.replace(/\/$/, '');
  // Explicit --host flag
  if (opts.flagHost) return opts.flagHost.replace(/\/$/, '');
  // --target flag
  if (opts.flagTarget) return hostForTarget(opts.flagTarget);

  // Persisted CLI config
  const cfg = load();
  if (cfg.host) return cfg.host.replace(/\/$/, '');
  if (cfg.target) return hostForTarget(cfg.target);

  return PROD_HOST;
}
