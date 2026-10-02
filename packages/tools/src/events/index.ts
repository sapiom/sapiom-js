/** SAP-3684: run credentials need the agents gateway rather than the org-key Events API. */
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
