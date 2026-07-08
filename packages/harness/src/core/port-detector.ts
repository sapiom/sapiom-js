/**
 * Dev-server port detection (workstream W5's backend slice).
 *
 * The Preview pane's "Preview :PORT" chip (CanvasPane.tsx) lights up from a
 * `port.detected` bus message. This is the detector behind that signal: feed
 * it raw text — pty output chunks as they arrive, or a `tool.call` event's
 * command/output — per session, and it calls `onPort` once per distinct
 * (session, port) `localhost:<port>` reference it finds. The integrator
 * wires `feed()` to both the pty output stream and the analytics ingest
 * pipeline, and broadcasts `{type: "port.detected", harnessSessionId, port,
 * url}` on /ws/events from `onPort`.
 */

const PORT_PATTERN_SOURCE = String.raw`(?:https?://)?localhost:(\d{2,5})\b`;

/** Long enough to hold the literal "localhost:" anchor split across a chunk
 *  boundary, plus a few digits either side. */
const TAIL_SAFETY = 24;

export interface PortDetectorDeps {
  onPort(harnessSessionId: string, port: number, url: string): void;
}

/**
 * Stateful, streaming-safe: a match that touches the very end of the
 * buffered text is held back rather than finalized, in case more digits are
 * still arriving in the next chunk (so this is safe to feed byte-for-byte
 * pty output, not just complete lines). Dedupes per (session, port) so a
 * port that keeps appearing in output only ever fires `onPort` once.
 */
export class PortDetector {
  private readonly buffers = new Map<string, string>();
  private readonly seenPorts = new Map<string, Set<number>>();

  constructor(private readonly deps: PortDetectorDeps) {}

  feed(chunk: string, harnessSessionId: string): void {
    const combined = (this.buffers.get(harnessSessionId) ?? "") + chunk;
    const regex = new RegExp(PORT_PATTERN_SOURCE, "g");

    let match: RegExpExecArray | null;
    let pendingFrom: number | null = null;

    while ((match = regex.exec(combined))) {
      const end = match.index + match[0].length;
      if (end === combined.length) {
        // Could still be growing (more digits due next chunk) — hold it back.
        pendingFrom = match.index;
        break;
      }
      this.tryEmit(harnessSessionId, Number(match[1]));
    }

    const retainFrom = pendingFrom ?? Math.max(0, combined.length - TAIL_SAFETY);
    this.buffers.set(harnessSessionId, combined.slice(retainFrom));
  }

  private tryEmit(harnessSessionId: string, port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;

    let ports = this.seenPorts.get(harnessSessionId);
    if (!ports) {
      ports = new Set();
      this.seenPorts.set(harnessSessionId, ports);
    }
    if (ports.has(port)) return;
    ports.add(port);

    this.deps.onPort(harnessSessionId, port, `http://localhost:${port}`);
  }

  /** Drops buffered/dedupe state for a session — call on session exit/kill so
   *  a reused session id (e.g. a fresh session in the same slot) starts clean. */
  reset(harnessSessionId: string): void {
    this.buffers.delete(harnessSessionId);
    this.seenPorts.delete(harnessSessionId);
  }
}
