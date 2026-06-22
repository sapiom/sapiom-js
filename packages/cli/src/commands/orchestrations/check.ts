import path from 'node:path';

import { check, OrchestrationError } from '@sapiom/orchestration-core';

import { CliError, isJsonMode, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations check [dir]` — validate an orchestration locally:
 * bundle index.ts, load it, derive the manifest, and check the step graph.
 * Offline and zero-cost; mirrors what the server build validates.
 */
export async function runCheck(dir: string | undefined): Promise<void> {
  const sourceDir = path.resolve(dir ?? process.cwd());

  let result;
  try {
    result = await check({ sourceDir });
  } catch (err) {
    if (err instanceof OrchestrationError) {
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
