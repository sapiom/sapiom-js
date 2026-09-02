import type { AnalyticsEvent, BusMessage } from "../shared/types.js";

type SessionRecordChangedMessage = Extract<
  BusMessage,
  { type: "session.record.changed" }
>;

/** Content-free invalidation for events that change the visible transcript. */
export function sessionRecordChangedMessage(
  event: AnalyticsEvent,
): SessionRecordChangedMessage | null {
  return event.type === "prompt.submitted" || event.type === "turn.completed"
    ? {
        type: "session.record.changed",
        harnessSessionId: event.harnessSessionId,
      }
    : null;
}
