/**
 * sendFeedback — relay a user's product feedback to the Sapiom team.
 *
 * Networked operation: requires a GatewayClient. All inputs passed explicitly.
 *
 * The route lives at the API host root rather than under `/v1/workflows` (it is
 * not a workflow resource), hence `postAtHostRoot` rather than `post`.
 *
 * Two deliberate departures from the neighbouring operations:
 *
 * - **No analytics wrapper.** `link`/`deploy`/`run` wrap themselves in a
 *   `workflow.*` track() because they are the activation funnel; `signal`,
 *   `inspect`, `clone` and the `schedule*` family do not. Feedback is neither,
 *   and its only caller (the `sapiom_send_feedback` MCP tool) already emits one
 *   `tool.call` event per invocation carrying the structured error code — so a
 *   wrapper here would double-count a single user action.
 * - **A missing `id` is tolerated, not an error.** `run` throws `RUN_NO_ID`
 *   because an execution you cannot address is useless. Here the id is only a
 *   reference number and the row already exists by the time we read the body;
 *   telling a user their feedback failed when it in fact landed is the worse
 *   outcome.
 */
import { GatewayClient } from './client.js';

/** Host-rooted, NOT under the client's `/v1/workflows` base. */
const FEEDBACK_PATH = '/v1/studio-feedback';

export interface SendFeedbackOptions {
  /** The user's feedback, verbatim. */
  message: string;
  /**
   * Optional plain-language summary of what the user was doing when the
   * feedback came up. Prose, not JSON — the backend stores and renders it as
   * text.
   */
  context?: string;
  /**
   * Client-collected environment facts (package versions, platform, environment
   * name, timestamp). Metadata only: never credentials, never a `process.env`
   * dump, and never tenant identity — the backend resolves the tenant from the
   * API key.
   *
   * Deliberately untyped, mirroring the backend's `clientMeta?: object`. The
   * shape is owned by the calling client (see `@sapiom/mcp`), so a caller adds
   * a field without an agent-core release, and the SDK does not invent a
   * second, stricter contract that the server does not enforce.
   */
  clientMeta?: Record<string, unknown>;
}

export interface SendFeedbackResult {
  /**
   * Server-assigned id of the stored feedback record. Optional: the 201 is
   * authoritative, its body is not guaranteed.
   */
  id?: string;
}

/**
 * Submit feedback. Throws `AgentOperationError` on gateway errors.
 */
export async function sendFeedback(
  opts: SendFeedbackOptions,
  client: GatewayClient,
): Promise<SendFeedbackResult> {
  // Omit rather than send empty values, so the backend's optionals stay
  // meaningfully optional. Both guards lead with truthiness rather than
  // `!== undefined`: a JS caller (or anything built from `JSON.parse`) can hand
  // us an explicit `null`, and `Object.keys(null)` throws.
  const res = await client.postAtHostRoot<{ id?: unknown }>(FEEDBACK_PATH, {
    message: opts.message,
    ...(opts.context ? { context: opts.context } : {}),
    ...(opts.clientMeta && Object.keys(opts.clientMeta).length > 0
      ? { clientMeta: opts.clientMeta }
      : {}),
  });
  return { id: typeof res?.id === 'string' ? res.id : undefined };
}
