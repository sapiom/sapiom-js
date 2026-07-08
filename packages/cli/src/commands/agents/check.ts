import path from 'node:path';

import { check, AgentOperationError } from '@sapiom/agent-core';

import { CliError, isJsonMode, ok } from '../../lib/output.js';

/**
 * `sapiom agents check [dir]` — validate an agent locally:
 * bundle index.ts, load it, derive the manifest, and check the step graph.
 * Offline and zero-cost; mirrors what the server build validates.
 */
export async function runCheck(dir: string | undefined): Promise<void> {
  const sourceDir = path.resolve(dir ?? process.cwd());

  let result;
  try {
    result = await check({ sourceDir });
  } catch (err) {
    if (err instanceof AgentOperationError) {
      throw new CliError(err.toStructured());
    }
    throw err;
  }

  const { name, stepCount, warnings, manifest } = result;

  if (isJsonMode()) {
    ok({ name, steps: stepCount, warnings, manifest });
  } else {
    ok({}, [`✓ ${name} — ${stepCount} step(s), graph OK`, ...warnings.map((w) => `  ⚠ ${w}`)]);
  }
}
