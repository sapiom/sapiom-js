/**
 * Assistant conversation stream — turn model, reducer, and a mock script.
 *
 * The Studio's assistant is a conversation that streams *turns* from the
 * intelligence spine (a Sapiom workflow run on our account, not the user's
 * Claude Code). That spine — its service and its wire contract — is a separate
 * workstream; until it lands, this pane is built against the mock script below
 * so it is buildable and testable on its own.
 *
 * This module is deliberately framework-free (no React, no DOM) so the
 * turn-reduction logic can be unit-tested under the Node vitest runner, the
 * same tier as the SPA's other pure logic (see assistant-stream.test.ts). The
 * React glue that plays the script into component state lives in
 * ./use-assistant-mock-stream.
 *
 * Shaped to swap onto the real spine with a source change only: the event
 * names (`turn.started` / `turn.delta` / `turn.completed`) mirror the "streams
 * turns" contract, and `reduceTurns` folds a raw event onto ordered turns
 * exactly as a live subscription would.
 */

/** Who authored a turn. `user` is the person; `assistant` is the Sapiom-run helper. */
export type AssistantTurnRole = "user" | "assistant";

/** A turn is `streaming` while deltas are still arriving, then `complete`. */
export type AssistantTurnStatus = "streaming" | "complete";

/** One conversation turn as the pane renders it — text accumulated from deltas. */
export interface AssistantTurn {
  /** Stable id for keyed rendering; also the join key for deltas/completion. */
  id: string;
  role: AssistantTurnRole;
  /** Full text so far (deltas appended in arrival order). */
  text: string;
  status: AssistantTurnStatus;
}

/**
 * A single frame off the stream. A turn opens with `turn.started`, grows via
 * zero or more `turn.delta`s, and closes with `turn.completed`. `text` on
 * `turn.started` seeds a turn that arrives whole (e.g. the user's own prompt).
 */
export type AssistantStreamEvent =
  | { type: "turn.started"; id: string; role: AssistantTurnRole; text?: string }
  | { type: "turn.delta"; id: string; text: string }
  | { type: "turn.completed"; id: string };

/**
 * Fold one stream event onto the current turns, returning a new array
 * (never mutating the input). Order-preserving: a turn keeps its first-seen
 * position for the whole run.
 *
 * Honest by omission — a `delta`/`completed` for an id that was never
 * `started` is ignored rather than conjuring a turn from a partial frame; a
 * repeated `started` for a known id is a no-op so a reconnect that replays the
 * opening frame can't duplicate a turn.
 */
export function reduceTurns(
  turns: readonly AssistantTurn[],
  event: AssistantStreamEvent,
): AssistantTurn[] {
  switch (event.type) {
    case "turn.started": {
      if (turns.some((turn) => turn.id === event.id)) return turns.slice();
      return [
        ...turns,
        {
          id: event.id,
          role: event.role,
          text: event.text ?? "",
          status: "streaming",
        },
      ];
    }
    case "turn.delta":
      return turns.map((turn) =>
        turn.id === event.id ? { ...turn, text: turn.text + event.text } : turn,
      );
    case "turn.completed":
      return turns.map((turn) =>
        turn.id === event.id ? { ...turn, status: "complete" } : turn,
      );
  }
}

/** Fold a whole event sequence — convenience for tests and replay. */
export function reduceTurnSequence(
  events: readonly AssistantStreamEvent[],
): AssistantTurn[] {
  return events.reduce<AssistantTurn[]>(
    (turns, event) => reduceTurns(turns, event),
    [],
  );
}

/** One scripted frame plus how long to wait before emitting it. */
export interface ScriptedFrame {
  event: AssistantStreamEvent;
  /** Delay (ms) after the previous frame before this one is emitted. */
  afterMs: number;
}

/** Inter-delta cadence for the mock — brisk enough to feel live, slow enough
 *  to read as a stream rather than a paste. */
const DELTA_MS = 140;

/**
 * A canned single-agent conversation, shaped like what the spine will stream:
 * the user asks the operate-only assistant to explain the open agent, and the
 * assistant answers in streamed deltas. Content is generic on purpose — the
 * pane is what's under test here, not any particular agent.
 */
export function mockConversationScript(): ScriptedFrame[] {
  const assistantDeltas = [
    "This agent watches an inbox for new leads. ",
    "Each message is scored, enriched with company details, ",
    "and routed to the right rep — or auto-replied when it's clearly spam.\n\n",
    "It runs three steps: **triage**, **enrich**, then **route**. ",
    "Ask me to run it, or open a step on the canvas to see its live cost.",
  ];

  return [
    {
      afterMs: 120,
      event: {
        type: "turn.started",
        id: "u1",
        role: "user",
        text: "What does this agent do?",
      },
    },
    { afterMs: 0, event: { type: "turn.completed", id: "u1" } },
    {
      afterMs: 260,
      event: { type: "turn.started", id: "a1", role: "assistant" },
    },
    ...assistantDeltas.map<ScriptedFrame>((text) => ({
      afterMs: DELTA_MS,
      event: { type: "turn.delta", id: "a1", text },
    })),
    { afterMs: DELTA_MS, event: { type: "turn.completed", id: "a1" } },
  ];
}
