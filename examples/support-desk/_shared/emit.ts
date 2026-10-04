/**
 * Emit a domain event: validate it against the catalog, pass a dedup id derived from
 * `causationId` so a retried step never fans out twice, and record it in `events_log`.
 *
 * The id is `<type>:<causationId>`, not the bare causationId: the gateway dedups on
 * `(tenant, 'events_api', id)` across all types, so one Slack event that causes two different
 * domain events would otherwise lose the second.
 */
import type { AgentExecutionContext } from "@sapiom/agent";
import type { EmitEventResult } from "@sapiom/tools";

import type { Db } from "./db";
import { Events, type EventPayload, type EventType } from "./events";
import { logEvent } from "./issues";

export type EmitCtx = Pick<
  AgentExecutionContext<Record<string, unknown>>,
  "sapiom" | "logger" | "agentName"
>;

export function emitId(type: EventType, causationId: string): string {
  return `${type}:${causationId}`;
}

export async function emit<T extends EventType>(
  ctx: EmitCtx,
  db: Db,
  type: T,
  payload: EventPayload<T>,
): Promise<EmitEventResult> {
  const events = (
    ctx.sapiom as {
      events?: {
        emit?: (spec: {
          type: string;
          payload: Record<string, unknown>;
          id?: string;
        }) => Promise<EmitEventResult>;
      };
    }
  ).events;
  if (typeof events?.emit !== "function") {
    throw new Error(
      "ctx.sapiom.events.emit is unavailable: this agent needs @sapiom/tools >= 0.40.0",
    );
  }
  const parsed = Events[type].parse(payload) as EventPayload<T>;
  const result = await events.emit({
    type,
    payload: parsed as Record<string, unknown>,
    id: emitId(type, parsed.causationId),
  });
  await logEvent(db, {
    type,
    payload: parsed,
    emittedBy: ctx.agentName,
    receiptId: result.receiptId,
  });
  ctx.logger.info(`emitted ${type}`, {
    receiptId: result.receiptId,
    outcome: result.outcome,
    duplicate: result.duplicate,
  });
  return result;
}
