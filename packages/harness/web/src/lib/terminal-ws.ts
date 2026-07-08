/** Builds the /ws/terminal URL for a given session, relative to the current origin. */
export function buildTerminalWsUrl(sessionId: string, token: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/terminal?session=${encodeURIComponent(
    sessionId,
  )}&token=${encodeURIComponent(token)}`;
}
