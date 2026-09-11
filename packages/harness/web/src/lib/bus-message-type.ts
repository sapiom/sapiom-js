import type { BusMessage } from "@shared/types";

// Keep the transport's supported discriminators exhaustive as the protocol
// evolves. Removed or unknown events never reach mounted state subscribers.
const supportedTypes: Record<BusMessage["type"], true> = {
  "session.status": true,
  "session.record.changed": true,
  "canvas.reload": true,
  "port.detected": true,
  "execution.started": true,
  "workflows.changed": true,
  "agent-map.proposal.changed": true,
  "agent-map.initialization.changed": true,
  "task.status": true,
  "session.activity": true,
  "auth.changed": true,
};

/** Checks the envelope's type only; consumers still own payload validation. */
export function hasKnownBusMessageType(
  value: unknown,
): value is { type: BusMessage["type"] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    Object.hasOwn(supportedTypes, value.type)
  );
}
