/**
 * `sapiom config set-target <prod|staging|local>` — persist the default API
 * target to `~/.sapiom/config.json`. `dev` is accepted as an alias for
 * `staging`. Individual commands can still override per-invocation with
 * `--target` or `--host`.
 */
import { type CliTarget, hostForTarget, writeCliConfig } from '../../lib/cli-config.js';
import { CliError, ok } from '../../lib/output.js';

/** Accepted user input → canonical target. `dev` is a friendly alias for `staging`. */
const TARGET_ALIASES: Record<string, CliTarget> = {
  prod: 'prod',
  staging: 'staging',
  dev: 'staging',
  local: 'local',
};

export async function runSetTarget(input: string): Promise<void> {
  const target = TARGET_ALIASES[input];
  if (!target) {
    throw new CliError({
      code: 'BAD_TARGET',
      message: `Unknown target: '${input}'. Expected 'prod', 'staging' (alias 'dev'), or 'local'.`,
    });
  }

  writeCliConfig({ target, host: undefined });

  ok({ target }, [`✓ Default target set to '${target}' (${hostForTarget(target)}).`]);
}
