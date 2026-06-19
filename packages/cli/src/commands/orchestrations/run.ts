import { readFileSync } from 'node:fs';

import { OrchestrationError, parseJsonInput, run } from '@sapiom/orchestration-core';

import { makeClient } from '../../lib/client.js';
import { requireConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations run` — start an execution of the linked orchestration.
 */
export async function runRun(opts: { input?: string; inputFile?: string }): Promise<void> {
  try {
    const dir = process.cwd();
    const cfg = requireConfig(dir);
    const client = makeClient(cfg.host);
    const input = resolveInput(opts);

    const result = await run({ definitionId: cfg.definitionId, input }, client);

    ok({ executionId: result.executionId, ...result.raw }, [
      `✓ Started execution ${result.executionId}`,
      `  inspect: sapiom orchestrations logs ${result.executionId}`,
    ]);
  } catch (err) {
    if (err instanceof OrchestrationError) throw new CliError(err.toStructured());
    throw err;
  }
}

function resolveInput(opts: { input?: string; inputFile?: string }): unknown {
  const raw = opts.inputFile ? readFileSync(opts.inputFile, 'utf8') : opts.input;
  if (!raw) return {};
  return parseJsonInput(raw);
}
