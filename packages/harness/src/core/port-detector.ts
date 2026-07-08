/**
 * Dev-server port detection (workstream W5's backend slice).
 *
 * The Preview pane's "Preview :PORT" chip (CanvasPane.tsx) lights up from a
 * `port.detected` bus message. The signal for that message is a
 * `localhost:<port>` reference showing up in a `tool.call` analytics event's
 * command/output — this module is the pure detector; the analytics ingest
 * pipeline (workstream W3) calls it per tool.call event and, on a hit,
 * broadcasts `{ type: "port.detected", harnessSessionId, port, url }` on
 * /ws/events.
 */

const PORT_REFERENCE = /\blocalhost:(\d{2,5})\b/;

/** Fields commonly carrying a Bash tool call's command/output in the
 *  schemaless AnalyticsEvent.payload. */
const CANDIDATE_FIELDS = ["command", "output", "stdout", "stderr", "result", "text"];

export interface DetectedPort {
  port: number;
  url: string;
}

/** Scans free-form text for a `localhost:<port>` reference. */
export function detectPort(text: string): DetectedPort | null {
  const match = PORT_REFERENCE.exec(text);
  if (!match) return null;

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  return { port, url: `http://localhost:${port}` };
}

/**
 * Scans a `tool.call` event's schemaless payload for a `localhost:<port>`
 * reference across the fields it's typically carried in. Returns the first
 * match found, checking fields in `CANDIDATE_FIELDS` order.
 */
export function detectPortInPayload(payload: Record<string, unknown>): DetectedPort | null {
  for (const field of CANDIDATE_FIELDS) {
    const value = payload[field];
    if (typeof value !== "string") continue;
    const found = detectPort(value);
    if (found) return found;
  }
  return null;
}
