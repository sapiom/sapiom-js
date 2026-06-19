import { OrchestrationError, parseSignalPayload, signal } from '@sapiom/orchestration-core';

import { makeClient } from '../../lib/client.js';
import { readConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations signal <executionId>` — resume a paused execution by
 * delivering a named signal (matched by name + correlation id).
 */
export async function runSignal(
  executionId: string,
  opts: { name: string; correlationId: string; payload?: string },
): Promise<void> {
  try {
    const cfg = readConfig(process.cwd());
    const client = makeClient(cfg?.host);
    const payload = opts.payload ? parseSignalPayload(opts.payload) : undefined;

    const result = await signal({ executionId, name: opts.name, correlationId: opts.correlationId, payload }, client);

    ok({ matched: result.matched }, [`✓ Signal '${opts.name}' delivered (matched ${result.matched}).`]);
  } catch (err) {
    if (err instanceof OrchestrationError) throw new CliError(err.toStructured());
    throw err;
  }
}
