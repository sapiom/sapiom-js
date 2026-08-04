/**
 * signal — announce a named signal inside the framed execution's tenant.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly.
 */
import { GatewayClient } from "./client.js";
import { AgentOperationError } from "./errors.js";

export interface SignalOptions {
  /** Existing execution used for ownership and tenant framing; routing uses the pair below. */
  executionId: string;
  name: string;
  correlationId: string;
  /** JSON object threaded into the resumed step as its input. */
  payload?: Record<string, unknown>;
}

export interface SignalResult {
  matched: number;
}

/**
 * Deliver a signal within the execution's tenant. Paused runs are matched by
 * `(name, correlationId)`, not by `executionId`; correlation IDs should be
 * unique per waiter. The result is the number of runs actually resumed, so 0
 * is an idempotent no-op and a non-unique pair can fan out to more than one.
 *
 * Throws `AgentOperationError` on invalid payload or gateway errors.
 */
export async function signal(
  opts: SignalOptions,
  client: GatewayClient,
): Promise<SignalResult> {
  const res = await client.post<{ matched?: number }>(
    `/executions/${opts.executionId}/signals`,
    {
      name: opts.name,
      correlationId: opts.correlationId,
      payload: opts.payload,
    },
  );
  return { matched: res.matched ?? 0 };
}

/**
 * Parse a JSON payload string for a signal. Exported so callers (CLI, MCP) can
 * normalize errors consistently.
 */
export function parseSignalPayload(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentOperationError({
      code: "BAD_PAYLOAD",
      message: "Signal payload is not valid JSON.",
    });
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new AgentOperationError({
      code: "BAD_PAYLOAD",
      message: "Signal payload must be a JSON object.",
    });
  }
  return parsed as Record<string, unknown>;
}
