/**
 * `events` capability: emit a tenant event from a running step, with the run's own credential.
 *
 *   import { events } from "@sapiom/tools";
 *   await events.emit({ type: "lead.created", payload: { leadId }, id: `lead-${leadId}` });
 *
 * An event STARTS every deployed agent whose `event` trigger matches its `type` (a signal, by
 * contrast, resumes one paused run). The route sits under the agents gateway (`/agents/v1`, same
 * front door as {@link ../agents/index.js}). Thin passthrough: the gateway validates the type and
 * payload, and the 202 receipt comes back as is.
 */
import { Transport, defaultTransport } from "../_client/index.js";

const DEFAULT_BASE_URL =
  process.env.SAPIOM_AGENTS_URL ??
  process.env.SAPIOM_TOOLS_BASE ??
  "https://tools.sapiom.ai";

export interface EmitEventSpec {
  /** Dotted event type, e.g. `lead.created`; matched against `event` triggers. */
  type: string;
  /** JSON object handed to every run the event starts. */
  payload: Record<string, unknown>;
  /**
   * Dedup key: a second emit with the same `id` starts nothing and returns `duplicate: true`.
   * Omit it and the gateway mints one, so a retried step would emit twice.
   */
  id?: string;
}

/** `unmatched` (no trigger listens for this type) is a normal outcome, not an error. */
export type EventOutcome = "matched" | "unmatched";

export interface EmitEventResult {
  receiptId: string;
  outcome: EventOutcome;
  /** True when an earlier emit already used this `id`. */
  duplicate: boolean;
  /** Fire ids of the runs this emit started; empty on a duplicate or when unmatched. */
  fireIds: string[];
}

/** Emit a tenant event; resolves with the gateway's 202 receipt. */
export async function emit(
  spec: EmitEventSpec,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<EmitEventResult> {
  return transport.request<EmitEventResult>(`${baseUrl}/agents/v1/events`, {
    method: "POST",
    body: JSON.stringify(spec),
  });
}
