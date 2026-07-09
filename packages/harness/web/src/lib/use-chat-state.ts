/**
 * Per-session chat state: accumulates chat.turn, chat.tool, and chat.history
 * bus events from subscribeEvents into per-session maps that ChatView renders.
 *
 * Responsibilities:
 *   - Receives chat events from the bus (via use-harness-state's lastMessage)
 *   - Maintains per-session turn lists and tool-call maps
 *   - Determines whether the agent is "working" (tool running or no Stop event yet)
 *
 * Privacy: chat events are UI-transport only — they never touch the analytics
 * store. This hook only reads from the bus; it never writes.
 */
import { useCallback, useRef, useState } from "react";

import type { BusMessage, ChatToolCall, ChatTurn } from "@shared/types";

export interface SessionChatState {
  turns: ChatTurn[];
  /** Most-recent tool calls, keyed by callId. Last status for each id wins. */
  toolCalls: Map<string, ChatToolCall>;
  /** True when any tool call is in "start" state (agent actively running a tool). */
  agentWorking: boolean;
  /**
   * Non-empty string when the agent is blocked on a permission prompt (the
   * `Notification` hook fired and no subsequent activity has cleared it).
   * Empty string = no banner. UI-transport only.
   */
  attentionMessage: string;
}

export interface UseChatStateReturn {
  /** Get the chat state for a specific session, or a default empty state. */
  getChatState(sessionId: string): SessionChatState;
  /** Called by useHarnessState when a new bus message arrives. */
  handleBusMessage(message: BusMessage): void;
}

const EMPTY_STATE: SessionChatState = {
  turns: [],
  toolCalls: new Map(),
  agentWorking: false,
  attentionMessage: "",
};

export function useChatState(): UseChatStateReturn {
  // Per-session state maps, kept in a ref to avoid triggering re-renders from
  // the bus-message handler; only the per-session state objects are in React
  // state so ChatView re-renders when its own data changes.
  const stateRef = useRef<Map<string, SessionChatState>>(new Map());
  // React state version counter: incrementing this causes useHarnessState
  // consumers to pick up the new chat state on next render.
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const getOrCreate = useCallback((sessionId: string): SessionChatState => {
    const existing = stateRef.current.get(sessionId);
    if (existing) return existing;
    const fresh: SessionChatState = {
      turns: [],
      toolCalls: new Map(),
      agentWorking: false,
      attentionMessage: "",
    };
    stateRef.current.set(sessionId, fresh);
    return fresh;
  }, []);

  const handleBusMessage = useCallback((message: BusMessage): void => {
    if (message.type === "chat.turn") {
      const state = getOrCreate(message.harnessSessionId);
      const idx = state.turns.findIndex((t) => t.turnId === message.turn.turnId);
      const newTurns =
        idx >= 0
          ? state.turns.map((t, i) => (i === idx ? message.turn : t))
          : [...state.turns, message.turn];
      stateRef.current.set(message.harnessSessionId, {
        ...state,
        turns: newTurns,
        // Belt-and-braces: also clear any pending attention banner when a new
        // turn arrives — the server emits an empty chat.attention for
        // PreToolUse/PostToolUse/Stop/UserPromptSubmit, but a chat.turn
        // arriving before the clearing chat.attention (e.g. on reconnect)
        // would leave the banner stuck. Clear here too so either path works.
        attentionMessage: "",
      });
      bump();
    } else if (message.type === "chat.tool") {
      const state = getOrCreate(message.harnessSessionId);
      const newToolCalls = new Map(state.toolCalls);
      newToolCalls.set(message.call.callId, message.call);
      const agentWorking = Array.from(newToolCalls.values()).some((c) => c.status === "start");
      stateRef.current.set(message.harnessSessionId, {
        ...state,
        toolCalls: newToolCalls,
        agentWorking,
        // Also clear the attention banner on any tool activity — the agent
        // is actively working, so the permission prompt was answered.
        attentionMessage: "",
      });
      bump();
    } else if (message.type === "chat.history") {
      const sessionId = message.history.harnessSessionId;
      const state = getOrCreate(sessionId);
      // Merge history with any live turns already accumulated, deduped by
      // turnId (history wins on conflict; live turns not in history are
      // appended in their original order). This handles the race where a
      // chat.turn arrives before the chat.history snapshot on reconnect —
      // both are preserved rather than the live turn being silently dropped.
      const historyTurnIds = new Set(message.history.turns.map((t) => t.turnId));
      const liveOnlyTurns = state.turns.filter((t) => !historyTurnIds.has(t.turnId));
      const merged = [...message.history.turns, ...liveOnlyTurns];
      stateRef.current.set(sessionId, {
        ...state,
        turns: merged,
      });
      bump();
    } else if (message.type === "chat.attention") {
      const state = getOrCreate(message.harnessSessionId);
      stateRef.current.set(message.harnessSessionId, {
        ...state,
        attentionMessage: message.message,
      });
      bump();
    }
  }, [getOrCreate, bump]);

  const getChatState = useCallback((sessionId: string): SessionChatState => {
    return stateRef.current.get(sessionId) ?? EMPTY_STATE;
  }, []);

  return { getChatState, handleBusMessage };
}
