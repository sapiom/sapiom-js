/**
 * React glue that plays the mock conversation script (assistant-stream.ts)
 * into turn state, imitating a live subscription to the intelligence spine.
 *
 * Mock-mode only: in a real install there is no spine wired yet (that is a
 * separate workstream), so this yields nothing rather than fabricating turns —
 * the pane then shows its honest empty state. When the spine lands, this hook
 * is the single swap point: replace the scripted timers with a subscription to
 * the event bus and feed the frames through the same `reduceTurns`.
 */
import { useEffect, useState } from "react";

import { isMockMode } from "./api";
import {
  mockConversationScript,
  reduceTurns,
  type AssistantTurn,
} from "./assistant-stream";

export function useAssistantMockStream(): AssistantTurn[] {
  const [turns, setTurns] = useState<AssistantTurn[]>([]);

  useEffect(() => {
    if (!isMockMode()) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    let elapsed = 0;
    for (const { event, afterMs } of mockConversationScript()) {
      elapsed += afterMs;
      timers.push(
        setTimeout(() => setTurns((prev) => reduceTurns(prev, event)), elapsed),
      );
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  return turns;
}
