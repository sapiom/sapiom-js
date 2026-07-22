/**
 * React hook wiring the intelligence-spine bus frames into the {@link SpineSink}
 * reducer (SAP-1804 spike).
 *
 * Subscribes to `/ws/events` DIRECTLY (its own subscription, like the run-poll
 * controller) rather than reading `use-harness-state`'s single `lastMessage`,
 * so no frame is dropped when several arrive in one tick — a sink must see
 * EVERY frame, not just the latest. Returns the accumulated per-run state; the
 * spike carries no rendering (the Assistant pane is SAP-1806).
 */
import { useEffect, useState } from "react";

import { subscribeEvents } from "./events";
import {
  emptySpineSink,
  foldSpineMessage,
  type SpineSinkState,
} from "./spine-sink";

export function useSpineSink(): SpineSinkState {
  const [state, setState] = useState<SpineSinkState>(emptySpineSink);

  useEffect(() => {
    return subscribeEvents((message) => {
      // foldSpineMessage returns the same reference for non-spine messages, so
      // setState is a no-op re-render only when a spine frame actually landed.
      setState((prev) => foldSpineMessage(prev, message));
    });
  }, []);

  return state;
}
