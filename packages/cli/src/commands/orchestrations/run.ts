import { readFileSync } from 'node:fs';

import { GatewayClient } from '../../lib/client.js';
import { requireConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

/**
 * `sapiom orchestrations run` — start an execution of the linked orchestration.
 */
export async function runRun(opts: { input?: string; inputFile?: string }): Promise<void> {
  const dir = process.cwd();
  const cfg = requireConfig(dir);
  const client = new GatewayClient(cfg.host);
  const input = parseInput(opts);

  const res = await client.post<{ executionId?: string; id?: string }>(
    `/definitions/${cfg.definitionId}/execute`,
    { input },
  );
  const executionId = res.executionId ?? res.id;

  ok({ executionId, ...res }, [
    `✓ Started execution ${executionId}`,
    `  inspect: sapiom orchestrations logs ${executionId}`,
  ]);
}

function parseInput(opts: { input?: string; inputFile?: string }): unknown {
  const raw = opts.inputFile ? readFileSync(opts.inputFile, 'utf8') : opts.input;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError({ code: 'BAD_INPUT', message: 'Input is not valid JSON.', hint: 'Pass --input \'{"key":"value"}\'' });
  }
}
