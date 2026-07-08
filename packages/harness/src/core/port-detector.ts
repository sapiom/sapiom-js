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
  /** Ports considered the harness's own infrastructure — a match against one
   *  of these is silently dropped (not even recorded as "seen") rather than
   *  broadcast as a discovery. Known ports at construction time; more can be
   *  added later via `addExcludedPort` (e.g. an ephemeral `port: 0` only
   *  resolves to its real bound port after the server starts listening,
   *  which happens after this detector is already constructed). */
  excludedPorts?: Iterable<number>;
}

/**
 * Extracts the port a URL string actually resolves to, including the
 * protocol's implicit default when none is written out explicitly (`new
 * URL(...).port` is `""` in that case, not the real port) — used to exclude
 * the analytics collector's own port from detection.
 */
export function portFromUrl(rawUrl: string): number | null {
  try {
    const url = new URL(rawUrl);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Stateful, streaming-safe: a match that touches the very end of the
 * buffered text is held back rather than finalized, in case more digits are
 * still arriving in the next chunk (so this is safe to feed byte-for-byte
 * pty output, not just complete lines). Call `flush()` after feeding a
 * discrete, already-complete string (e.g. one tool.call event's output) —
 * see its doc comment for why that's necessary. Dedupes per (session, port)
 * so a port that keeps appearing in output only ever fires `onPort` once —
 * permanently for the session's lifetime (not a TTL): `reset()` is what
 * clears it, on session exit, so a reused session id starts clean.
 */
export class PortDetector {
  private readonly buffers = new Map<string, string>();
  private readonly seenPorts = new Map<string, Set<number>>();
  private readonly excludedPorts: Set<number>;

  constructor(private readonly deps: PortDetectorDeps) {
    this.excludedPorts = new Set(deps.excludedPorts ?? []);
  }

  /** Exclude a port discovered after construction — e.g. the harness's own
   *  actual bound port, which is only known once the HTTP server resolves
   *  its `listen()` call (relevant for an ephemeral `port: 0`). */
  addExcludedPort(port: number): void {
    this.excludedPorts.add(port);
  }

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
    // Never even recorded as "seen" — an excluded port isn't a real
    // discovery, so it shouldn't consume per-session dedupe state either.
    if (this.excludedPorts.has(port)) return;

    let ports = this.seenPorts.get(harnessSessionId);
    if (!ports) {
      ports = new Set();
      this.seenPorts.set(harnessSessionId, ports);
    }
    if (ports.has(port)) return;
    ports.add(port);

    this.deps.onPort(harnessSessionId, port, `http://localhost:${port}`);
  }

  /**
   * Finalizes whatever's currently held back for a session, immediately.
   * `feed()` deliberately withholds a match touching the end of the buffered
   * text in case more digits are still arriving — correct for a live pty
   * byte stream, but wrong for a single discrete, complete string (e.g. one
   * `tool.call` event's already-finished output) where no "next chunk" is
   * ever coming: without this, a port at the very end of that string (a
   * common shape — "...started server on http://localhost:5544") would be
   * held pending forever and `onPort` would never fire. Call this right
   * after `feed()` whenever the fed text is known to be complete.
   */
  flush(harnessSessionId: string): void {
    const pending = this.buffers.get(harnessSessionId);
    if (!pending) return;

    const regex = new RegExp(PORT_PATTERN_SOURCE, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(pending))) {
      this.tryEmit(harnessSessionId, Number(match[1]));
    }
    this.buffers.delete(harnessSessionId);
  }

  /** Drops buffered/dedupe state for a session — call on session exit/kill so
   *  a reused session id (e.g. a fresh session in the same slot) starts clean. */
  reset(harnessSessionId: string): void {
    this.buffers.delete(harnessSessionId);
    this.seenPorts.delete(harnessSessionId);
  }
}
