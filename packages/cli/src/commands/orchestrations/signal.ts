import { GatewayClient } from '../../lib/client.js';
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
  const cfg = readConfig(process.cwd());
  const client = new GatewayClient(cfg?.host);

  let payload: unknown;
  if (opts.payload) {
    try {
      payload = JSON.parse(opts.payload);
    } catch {
      throw new CliError({ code: 'BAD_PAYLOAD', message: 'Signal payload is not valid JSON.' });
    }
  }

  const res = await client.post<{ matched?: number }>(`/executions/${executionId}/signals`, {
    name: opts.name,
    correlationId: opts.correlationId,
    payload,
  });

  ok({ matched: res.matched }, [`✓ Signal '${opts.name}' delivered (matched ${res.matched ?? 0}).`]);
}
