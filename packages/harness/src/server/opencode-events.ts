import { once } from "node:events";
import type { Response } from "express";
import {
  OpenCodeTransportError,
  type HostedOpenCode,
} from "../core/opencode-host.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Scope before sending any bytes to the browser, including conflicting nested IDs. */
export function scopedOpenCodeEvent(
  value: unknown,
  id: string,
  scope?: { cwd: string; isCurrent: () => boolean },
): Record<string, unknown> | null {
  const envelope = record(value);
  const event = record(envelope.payload ?? value);
  const properties = record(event.properties);
  if (scope && !scope.isCurrent()) return null;
  if (
    scope &&
    envelope.payload !== undefined &&
    envelope.directory !== undefined &&
    envelope.directory !== scope.cwd
  )
    return null;
  if (event.type === "studio.error") return null;
  if (event.type === "server.connected" || event.type === "server.heartbeat")
    return { type: event.type, properties: {} };
  const info = record(properties.info);
  const ids = [
    properties.sessionID,
    info.sessionID,
    record(properties.part).sessionID,
  ];
  if (
    ["session.created", "session.updated", "session.deleted"].includes(
      String(event.type),
    )
  )
    ids.push(info.id);
  const present = ids.filter((value) => value !== undefined);
  if (
    event.type === "session.error" &&
    record(properties.error).name === "ProviderAuthError" &&
    record(record(properties.error).data).providerID === "sapiom" &&
    ((present.length > 0 && present.every((value) => value === id)) ||
      (present.length === 0 &&
        scope &&
        envelope.payload !== undefined &&
        envelope.directory === scope.cwd))
  )
    return {
      type: "studio.error",
      properties: openCodeTransportFailure("authentication_required"),
    };
  return present.length > 0 && present.every((value) => value === id)
    ? event
    : null;
}

/** Read one connection lazily, yielding scoped events with consumer backpressure. */
export async function* readOpenCodeEvents(
  hosted: HostedOpenCode,
  id: string,
  signal: AbortSignal,
  onOpen?: () => void,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  signal.throwIfAborted();
  const upstream = await hosted.server.fetch("/event", {
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (
    signal.aborted ||
    !upstream.ok ||
    !upstream.body ||
    !upstream.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await upstream.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    throw new Error("Assistant event connection failed");
  }
  const reader = upstream.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  // Decoded string units per frame, including an incomplete trailing frame.
  const maxFrame = 2 * 1024 * 1024;
  try {
    signal.throwIfAborted();
    onOpen?.();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return;
      pending = (pending + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        signal.throwIfAborted();
        if (boundary > maxFrame)
          throw new Error("Assistant event is too large");
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = scopedOpenCodeEvent(JSON.parse(data), id, hosted);
        if (!event) continue;
        yield event;
        if (event.type === "studio.error") return;
      }
      if (pending.length > maxFrame)
        throw new Error("Assistant event is too large");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Browser transport owns response framing and its one status catch-up read. */
export async function streamOpenCodeEvents(
  hosted: HostedOpenCode,
  id: string,
  res: Response,
  signal: AbortSignal,
): Promise<void> {
  const lifetime = new AbortController();
  const connection = AbortSignal.any([signal, lifetime.signal]);
  let opened = false;
  let finished = false;
  let statusSeen = false;
  let writeTail = Promise.resolve();
  const write = (event: Record<string, unknown>, fallback = false) => {
    const pending = writeTail.then(async () => {
      if (finished || (fallback && statusSeen) || !hosted.isCurrent()) return;
      connection.throwIfAborted();
      if (!res.write(`data: ${JSON.stringify(event)}\n\n`))
        await once(res, "drain", { signal: connection });
    });
    writeTail = pending.catch(() => {});
    return pending;
  };
  const onOpen = () => {
    opened = true;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    // A live status always wins, including while a fallback waits for drain.
    void hosted.server
      .fetchJson<Record<string, unknown>>("/session/status", {
        signal: AbortSignal.any([connection, AbortSignal.timeout(3000)]),
      })
      .then((statuses) =>
        write(
          {
            type: "session.status",
            properties: {
              sessionID: id,
              status: statuses[id] ?? { type: "idle" },
            },
          },
          true,
        ),
      )
      .catch(() => {});
  };
  try {
    for await (const event of readOpenCodeEvents(
      hosted,
      id,
      connection,
      onOpen,
    )) {
      if (
        ["session.status", "session.idle", "studio.error"].includes(
          String(event.type),
        )
      )
        statusSeen = true;
      await write(event);
      if (event.type === "studio.error") break;
    }
    finished = true;
    res.end();
  } catch (error) {
    finished = true;
    if (
      opened &&
      signal.reason instanceof OpenCodeTransportError &&
      !res.destroyed &&
      !res.writableEnded
    ) {
      res.write(
        `data: ${JSON.stringify({
          type: "studio.error",
          properties: signal.reason.failure,
        })}\n\n`,
      );
      res.end();
      return;
    }
    throw error;
  } finally {
    finished = true;
    lifetime.abort();
  }
}
