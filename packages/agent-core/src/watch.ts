/**
 * watchExecution — a live async-iterator over a run's Server-Sent Events channel
 * (Module A / SAP-1139). Yields `SseEvent`s (IDs only) as the engine reports a
 * change; consumers refetch the canonical projection via `inspect()`.
 *
 * Networked operation: requires a GatewayClient. Mirrors the async-iterator
 * streaming pattern in `@sapiom/sandbox` `execStream()` (`fetch().body.getReader()`
 * + `TextDecoder` + `async function*`), adapted to SSE framing (`data:`/`event:`/
 * `id:` fields, `Last-Event-ID` resume). Teardown (iterator `return`/`break`) runs
 * the generator's `finally`, which aborts the underlying fetch — no leaked
 * connections.
 */
import type { GatewayClient } from "./client.js";
import { SSE_EVENT_TYPES, type SseEvent, type SseEventType } from "./types.js";

export interface WatchExecutionOptions {
  executionId: string;
  /**
   * Resume cursor forwarded as `Last-Event-ID` on the handshake — best-effort
   * resume across an engine advance. The poll fallback in `waitForExecution`
   * covers any gap, so this is an optimization, not a correctness requirement.
   */
  lastEventId?: string;
  /**
   * Abort the stream from the outside (in addition to iterator teardown). When
   * this fires, the underlying fetch is aborted and the iterator completes.
   */
  signal?: AbortSignal;
}

/**
 * Stream live `SseEvent`s for one execution (the run plus its dispatch subtree)
 * over `GET /v1/workflows/executions/:id/stream`. Heartbeat frames and malformed
 * frames are filtered — only well-formed run events are yielded.
 *
 * Throws `AgentOperationError` (code `HTTP_*` | `NETWORK`) if the handshake fails.
 * A mid-stream transport drop surfaces as a thrown error from the iterator (the
 * caller — e.g. `waitForExecution` — reverts to polling).
 */
export async function* watchExecution(
  opts: WatchExecutionOptions,
  client: GatewayClient,
): AsyncGenerator<SseEvent> {
  // Our own controller so iterator teardown (return/break/throw) always aborts
  // the fetch, even when the caller passed no signal.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const path = `/executions/${encodeURIComponent(opts.executionId)}/stream`;

  try {
    const res = await client.openStream(path, {
      signal: controller.signal,
      lastEventId: opts.lastEventId,
    });
    // openStream guarantees a non-null body on success.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line. `indexOfFrameBoundary`
        // handles both the engine's `\n\n` framing and any CRLF intermediary.
        for (;;) {
          const boundary = indexOfFrameBoundary(buffer);
          if (boundary === -1) break;
          const raw = buffer.slice(0, boundary.at);
          buffer = buffer.slice(boundary.after);
          const event = parseSseFrame(raw);
          if (event) yield event;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    // Teardown: abort the fetch and detach the external-abort listener so a
    // long-lived caller signal never accumulates listeners.
    controller.abort();
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Locate the next frame boundary (`\n\n` or `\r\n\r\n`) in the buffer. Returns
 * where the frame ends (`at`) and where the next frame begins (`after`), or `-1`
 * when no complete frame is buffered yet.
 */
function indexOfFrameBoundary(buffer: string): { at: number; after: number } | -1 {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  // Pick whichever boundary comes first; account for its width.
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, after: crlf + 4 };
  return { at: lf, after: lf + 2 };
}

/**
 * Parse one SSE frame into an {@link SseEvent}, or `null` when the frame carries
 * no run event (a heartbeat, a comment, a `retry:` hint, or a payload that does
 * not narrow to a known event). The `data:` payload already contains the full
 * IDs-only frame, so it is the authoritative source; the `event:` name is
 * advisory and heartbeats are dropped by the narrowing in {@link parseSseEvent}.
 */
export function parseSseFrame(raw: string): SseEvent | null {
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    // Blank lines and comments (`:` prefix, e.g. `: heartbeat`) carry no field.
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Per the SSE spec a single leading space after the colon is stripped.
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return parseSseEvent(dataLines.join("\n"));
}

/**
 * Narrow a raw SSE `data:` payload to an {@link SseEvent}. A stream is
 * fire-and-forget, so a malformed, foreign, or heartbeat (`{}`) payload must be
 * dropped, never trusted — this mirrors the engine's `parseChannelMessage`.
 */
export function parseSseEvent(raw: string): SseEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.type !== "string" || !(SSE_EVENT_TYPES as readonly string[]).includes(m.type)) {
    return null;
  }
  if (typeof m.executionId !== "string" || m.executionId.length === 0) return null;
  return {
    type: m.type as SseEventType,
    executionId: m.executionId,
    traceRoot: typeof m.traceRoot === "string" ? m.traceRoot : null,
    nodeId: typeof m.nodeId === "string" ? m.nodeId : null,
  };
}
