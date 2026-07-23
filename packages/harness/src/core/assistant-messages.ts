/**
 * assistant-messages — the pure message-shaping half of the intelligence spine
 * (SAP-1807).
 *
 * The dispatcher (./tool-dispatcher.ts) owns the I/O: it runs a named Sapiom
 * workflow on our account and forwards frames onto the event bus. This module
 * owns the SHAPE of what it forwards — a set of clock-free, I/O-free builders
 * that turn dispatch state into the typed `assistant.*` {@link BusMessage}
 * variants. Keeping the shaping pure means the wire contract can be unit-tested
 * on its own (assistant-messages.test.ts), the same tier as the SPA's other
 * pure logic, and the dispatcher's own test only has to prove it calls these in
 * the right order with the right arguments.
 *
 * Honest by construction: `toolResult` omits `executionId`/`status` when the
 * cloud run never materialized rather than emitting a fake id or a `$0`-style
 * placeholder, matching the run viewer's honest-absence invariant.
 */

import type {
  AssistantTurnRole,
  BusMessage,
  RunView,
  StepView,
} from "../shared/types.js";

/** `assistant.tool_call` — the assistant is invoking `tool` with `input`. */
export function toolCall(
  dispatchId: string,
  tool: string,
  input: Record<string, unknown>,
): BusMessage {
  return { type: "assistant.tool_call", dispatchId, tool, input };
}

/** `assistant.turn` opening frame — seeds a turn (optionally whole, via `text`). */
export function turnStarted(
  dispatchId: string,
  turnId: string,
  role: AssistantTurnRole,
  text?: string,
): BusMessage {
  return {
    type: "assistant.turn",
    dispatchId,
    turnId,
    frame: text === undefined ? { kind: "started", role } : { kind: "started", role, text },
  };
}

/** `assistant.turn` delta — appends `text` to the open turn. */
export function turnDelta(
  dispatchId: string,
  turnId: string,
  text: string,
): BusMessage {
  return {
    type: "assistant.turn",
    dispatchId,
    turnId,
    frame: { kind: "delta", text },
  };
}

/** `assistant.turn` closing frame — the turn is done streaming. */
export function turnCompleted(dispatchId: string, turnId: string): BusMessage {
  return {
    type: "assistant.turn",
    dispatchId,
    turnId,
    frame: { kind: "completed" },
  };
}

/** Outcome of a dispatch, folded into `assistant.tool_result`. */
export interface ToolOutcome {
  ok: boolean;
  /** Present only once the cloud run materialized; omitted otherwise. */
  executionId?: string;
  /** Terminal run status; omitted when the run never materialized. */
  status?: RunView["status"];
}

/**
 * `assistant.tool_result` — the tool run's terminal outcome. `executionId` and
 * `status` are threaded through only when observed (honest absence): a dispatch
 * that failed before enqueue carries neither.
 */
export function toolResult(
  dispatchId: string,
  tool: string,
  outcome: ToolOutcome,
): BusMessage {
  const message: Extract<BusMessage, { type: "assistant.tool_result" }> = {
    type: "assistant.tool_result",
    dispatchId,
    tool,
    ok: outcome.ok,
  };
  if (outcome.executionId !== undefined) message.executionId = outcome.executionId;
  if (outcome.status !== undefined) message.status = outcome.status;
  return message;
}

/** `assistant.error` — the dispatch could not complete; the app degrades. */
export function errorMessage(dispatchId: string, error: string): BusMessage {
  return { type: "assistant.error", dispatchId, error };
}

/**
 * A concise, factual one-line reflection of a step transition, used as the text
 * of a streamed assistant-turn delta. Derived entirely from the observed
 * {@link StepView} — never fabricated prose — so the assistant's live turn is an
 * honest narration of what the workflow is actually doing:
 *
 *   pending  → `enrich: queued`
 *   running  → `enrich: running…`
 *   passed   → `enrich: done`
 *   failed   → `enrich: failed — <error>` (only when the step recorded one)
 *
 * A trailing newline keeps successive deltas on their own lines in the pane's
 * Markdown render.
 */
export function describeStep(step: StepView): string {
  switch (step.status) {
    case "pending":
      return `${step.name}: queued\n`;
    case "running":
      return `${step.name}: running…\n`;
    case "passed":
      return `${step.name}: done\n`;
    case "failed":
      return step.error
        ? `${step.name}: failed — ${step.error}\n`
        : `${step.name}: failed\n`;
  }
}
