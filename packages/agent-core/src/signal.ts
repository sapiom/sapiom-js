/**
 * signal — resume a paused execution by delivering a named signal.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly.
 *
 * This is the RESUME verb; `events.ts` is the start verb. A signal only ever
 * wakes runs that already paused on it — it cannot start one. Events start,
 * signals resume.
 *
 * Two things about the route that the signature does not show:
 *
 * - **Routing is by `(name, correlationId)`, not by `executionId`.** The
 *   execution id frames the REST resource and lets the server 404 a bad id
 *   before anything fires; the pair is what the pause directive declared and
 *   what the delivery is matched on. So one call resumes 0..N runs waiting on
 *   that pair, not necessarily the one named in `executionId`. That is the
 *   "wait for any signal matching X" pattern, and narrowing to the id would
 *   break it. The blast radius is the caller's own tenant either way.
 * - **An execution id is required.** There is no id-less signal route, so
 *   there is no `sendSignal(name, correlationId, payload)` here: pass any of
 *   the waiting runs and the fanout does the rest.
 */
import { GatewayClient } from "./client.js";
import { AgentOperationError } from "./errors.js";

export interface SignalOptions {
  /**
   * A paused execution, as the addressable resource. Existence and ownership
   * gate only — see the module header: the delivery is matched on
   * `(name, correlationId)`, so this need not be the only run that resumes.
   */
  executionId: string;
  /** The signal name the paused execution declared. Any string the author chose. */
  name: string;
  /** Narrows the match to a specific waiter, or to a set of them. */
  correlationId: string;
  /**
   * Threaded through as the resumed step's input. Typed `unknown` for
   * compatibility; the server requires a JSON object, so anything else 400s.
   */
  payload?: unknown;
}

export interface SignalResult {
  /**
   * How many paused executions ACTUALLY RESUMED — not how many matched the
   * pair. So `0` does not mean nothing was waiting, and on a partial fanout
   * this under-reports: read `message` whenever it is present.
   */
  matched: number;
  /**
   * Present whenever `matched` needs qualifying — nothing was waiting, waiters
   * matched but none resumed, or only some of them did. Absent on a clean full
   * fanout, so its presence is itself the signal to surface it to a human.
   */
  message?: string;
}

/**
 * Deliver a signal to a paused execution.
 *
 * Throws `AgentOperationError` on invalid payload or gateway errors.
 */
export async function signal(
  opts: SignalOptions,
  client: GatewayClient,
): Promise<SignalResult> {
  const res = await client.post<{ matched?: number; message?: string }>(
    `/executions/${opts.executionId}/signals`,
    {
      name: opts.name,
      correlationId: opts.correlationId,
      payload: opts.payload,
    },
  );
  return {
    matched: res.matched ?? 0,
    // Forwarded only when the server sent one: an explicit `message: undefined`
    // would show up in the CLI's `--json` output as a field that is always
    // there and usually null, which is the opposite of "read it when present".
    ...(res.message !== undefined ? { message: res.message } : {}),
  };
}

/**
 * Parse a JSON payload string for a signal. Exported so callers (CLI, MCP) can
 * normalize errors consistently.
 */
export function parseSignalPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AgentOperationError({
      code: "BAD_PAYLOAD",
      message: "Signal payload is not valid JSON.",
    });
  }
}
