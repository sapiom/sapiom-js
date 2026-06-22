/**
 * signal — resume a paused execution by delivering a named signal.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly.
 */
import { GatewayClient } from './client.js';
import { OrchestrationError } from './errors.js';

export interface SignalOptions {
  executionId: string;
  name: string;
  correlationId: string;
  payload?: unknown;
}

export interface SignalResult {
  matched: number;
}

/**
 * Deliver a signal to a paused execution.
 *
 * Throws `OrchestrationError` on invalid payload or gateway errors.
 */
export async function signal(opts: SignalOptions, client: GatewayClient): Promise<SignalResult> {
  const res = await client.post<{ matched?: number }>(`/executions/${opts.executionId}/signals`, {
    name: opts.name,
    correlationId: opts.correlationId,
    payload: opts.payload,
  });
  return { matched: res.matched ?? 0 };
}

/**
 * Parse a JSON payload string for a signal. Exported so callers (CLI, MCP) can
 * normalize errors consistently.
 */
export function parseSignalPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new OrchestrationError({
      code: 'BAD_PAYLOAD',
      message: 'Signal payload is not valid JSON.',
    });
  }
}
