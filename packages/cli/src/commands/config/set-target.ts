/**
 * `sapiom config set-target <prod|local>` — persist the default API target to
 * `~/.sapiom/config.json`. Individual commands can still override per-invocation
 * with `--target` or `--host`.
 */
import { type CliTarget, writeCliConfig } from '../../lib/cli-config.js';
import { CliError, ok } from '../../lib/output.js';

const VALID_TARGETS = new Set<string>(['prod', 'local']);

export async function runSetTarget(target: string): Promise<void> {
  if (!VALID_TARGETS.has(target)) {
    throw new CliError({
      code: 'BAD_TARGET',
      message: `Unknown target: '${target}'. Expected 'prod' or 'local'.`,
    });
  }

  writeCliConfig({ target: target as CliTarget, host: undefined });

  const description = target === 'local' ? 'http://localhost:3000' : 'https://api.sapiom.ai';
  ok({ target }, [`✓ Default target set to '${target}' (${description}).`]);
}
