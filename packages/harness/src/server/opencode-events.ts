import { once } from "node:events";
import type { Response } from "express";
import type { OpenCodeServer } from "@sapiom/opencode";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Scope before sending any bytes to the browser, including conflicting nested IDs. */
export function scopedOpenCodeEvent(
  value: unknown,
  id: string,
): Record<string, unknown> | null {
  const envelope = record(value);
  const event = record(envelope.payload ?? value);
  const properties = record(event.properties);
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
  return present.length > 0 && present.every((value) => value === id)
    ? event
    : null;
}

/** Buffer at most one incomplete frame; never collect the complete response. */
export async function streamOpenCodeEvents(
  server: OpenCodeServer,
  id: string,
  res: Response,
  signal: AbortSignal,
): Promise<void> {
  const upstream = await server.fetch("/event", {
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (
    !upstream.ok ||
    !upstream.body ||
    !upstream.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await upstream.body?.cancel();
    throw new Error("Assistant event connection failed");
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const write = async (event: Record<string, unknown>) => {
    signal.throwIfAborted();
    if (!res.write(`data: ${JSON.stringify(event)}\n\n`))
      await once(res, "drain", { signal });
  };
  let statusSeen = false;
  // Start after subscribing; never overwrite a newer native status with this snapshot.
  void server
    .fetchJson<Record<string, unknown>>("/session/status", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    })
    .then(async (statuses) => {
      if (!statusSeen && !signal.aborted && !res.writableEnded)
        await write({
          type: "session.status",
          properties: {
            sessionID: id,
            status: statuses[id] ?? { type: "idle" },
          },
        });
    })
    .catch(() => {});
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const maxFrame = 2 * 1024 * 1024;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = (pending + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
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
        const event = scopedOpenCodeEvent(JSON.parse(data), id);
        if (!event) continue;
        if (event.type === "session.status" || event.type === "session.idle")
          statusSeen = true;
        await write(event);
      }
      if (pending.length > maxFrame)
        throw new Error("Assistant event is too large");
    }
    res.end();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
