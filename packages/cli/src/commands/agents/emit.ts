import {
  AgentOperationError,
  emitEvent,
  parseEventPayload,
  type EmitEventResult,
} from "@sapiom/agent-core";

import { type CliTarget, makeClient } from "../../lib/client.js";
import { readConfig } from "../../lib/config.js";
import { CliError, ok } from "../../lib/output.js";

/**
 * `sapiom agents emit <type>` — emit a custom event for this tenant. It fans
 * out by type to every active `event` trigger and starts 0..N new runs.
 *
 * The sibling of `agents signal`, and the other half of it: this one starts
 * runs, that one resumes paused ones. Unlike `signal` it takes no execution id,
 * because an event is addressed to whatever subscribes to it rather than to a
 * run that already exists.
 */
export async function runEmit(
  type: string,
  opts: {
    payload: string;
    eventId?: string;
    host?: string;
    target?: CliTarget;
  },
): Promise<void> {
  try {
    const cfg = readConfig(process.cwd());
    const client = makeClient({
      projectHost: cfg?.host,
      flagHost: opts.host,
      flagTarget: opts.target,
    });
    const payload = parseEventPayload(opts.payload);

    const result = await emitEvent(
      { type, payload, eventId: opts.eventId },
      client,
    );

    ok({ ...result }, [describeEmit(type, result)]);
  } catch (err) {
    if (err instanceof AgentOperationError)
      throw new CliError(err.toStructured());
    throw err;
  }
}

/**
 * The one human line. All three outcomes are a success — the route 202s
 * whether or not anything subscribed — so the difference has to be stated,
 * or "accepted" reads as "something ran" when nothing did.
 */
function describeEmit(type: string, result: EmitEventResult): string {
  if (result.duplicate) {
    return `✓ Event '${type}' was already received (receipt ${result.receiptId}); nothing new started.`;
  }
  if (result.outcome === "unmatched") {
    return `✓ Event '${type}' recorded (receipt ${result.receiptId}), but no active event trigger subscribes to it — check the type for a typo, or arm a trigger on it.`;
  }
  // "fired N trigger(s)", not "started N runs": a fire is not yet a run. The
  // 202 means the receipt is committed and the fires are queued, and a fire can
  // still fail before it creates an execution — `sapiom agents logs` is where
  // you find out which did. Promising runs here would be the one claim this
  // response cannot support.
  const fires = result.fireIds.length;
  return `✓ Event '${type}' accepted (receipt ${result.receiptId}); fired ${fires} trigger${fires === 1 ? "" : "s"}.`;
}
