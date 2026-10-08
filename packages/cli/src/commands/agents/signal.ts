import { AgentOperationError, parseSignalPayload, signal } from '@sapiom/agent-core';

import { type CliTarget, makeClient } from '../../lib/client.js';
import { readConfig } from '../../lib/config.js';
import { CliError, ok } from '../../lib/output.js';

/**
 * `sapiom agents signal <executionId>` — resume a paused execution by
 * delivering a named signal (matched by name + correlation id).
 */
export async function runSignal(
  executionId: string,
  opts: { name: string; correlationId: string; payload?: string; host?: string; target?: CliTarget },
): Promise<void> {
  try {
    const cfg = readConfig(process.cwd());
    const client = makeClient({ projectHost: cfg?.host, flagHost: opts.host, flagTarget: opts.target });
    const payload = opts.payload ? parseSignalPayload(opts.payload) : undefined;

    const result = await signal({ executionId, name: opts.name, correlationId: opts.correlationId, payload }, client);

    // `message` is forwarded, not dropped. `matched` counts the runs that
    // ACTUALLY resumed, so it under-reports a partial fanout and a 0 does not
    // prove nothing was waiting — the server sends `message` exactly when the
    // count needs qualifying, and a CLI that printed only the count would state
    // the ambiguous half and swallow the half that resolves it.
    // `--json` mirrors the SDK result exactly — present means present, so the
    // test is `!== undefined` and an empty string survives as one. The human
    // line uses truthiness instead, because a blank indented line under the
    // success line reads as a rendering bug rather than as information.
    ok({ matched: result.matched, ...(result.message !== undefined ? { message: result.message } : {}) }, [
      `✓ Signal '${opts.name}' delivered (matched ${result.matched}).`,
      ...(result.message ? [`  ${result.message}`] : []),
    ]);
  } catch (err) {
    if (err instanceof AgentOperationError) throw new CliError(err.toStructured());
    throw err;
  }
}
