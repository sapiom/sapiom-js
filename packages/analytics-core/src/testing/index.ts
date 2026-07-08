/**
 * `@sapiom/analytics-core/testing` — an in-process mock of the Sapiom
 * analytics collector, for use in tests (this package's and any package that
 * instruments with the emitter).
 *
 *   import { startMockCollector } from "@sapiom/analytics-core/testing";
 *
 *   const collector = await startMockCollector();
 *   const analytics = createAnalytics({ ..., endpoint: collector.url });
 *   analytics.track("some_event");
 *   await analytics.flush();
 *   expect(collector.events()).toHaveLength(1);
 *   await collector.close();
 *
 * The mock is a real HTTP server on `127.0.0.1` (random port), so it
 * exercises the full delivery path — native `fetch`, headers, timeouts. Its
 * healthy responses approximate the collector contract (see CONTRACT.md):
 * `202 {"accepted":n,"dropped":0}` for any parseable JSON body, `400` for an
 * unparseable body, `413` for more than 500 events. Failure modes can be
 * scripted with {@link MockCollector.setMode}.
 *
 * Zero dependencies: Node built-ins only.
 */
import * as http from "http";
import type { AddressInfo, Socket } from "net";

import type { Envelope } from "../types.js";

/** Path suffix of {@link MockCollector.url}, mirroring the real collector. */
export const MOCK_COLLECTOR_PATH = "/v1/analytics/collector";

/** Contract limit mirrored by the mock: batches above this get a 413. */
export const MOCK_MAX_BATCH_EVENTS = 500;

/**
 * Scripted collector behavior:
 * - `ok`     — contract-shaped responses (202 / 400 / 413); the default
 * - `down`   — the connection is destroyed before any response is written
 *              (the client sees a socket-level failure)
 * - `slow`   — respond only after `delayMs` (default status 202)
 * - `status` — always respond with the given status (e.g. 500, 429)
 */
export type MockCollectorMode =
  | { kind: "ok" }
  | { kind: "down" }
  | { kind: "slow"; delayMs: number; status?: number }
  | { kind: "status"; status: number; body?: string };

/** One captured HTTP request, in arrival order. */
export interface CapturedRequest {
  method: string;
  path: string;
  /** Header names lowercased; multi-value headers joined with ", ". */
  headers: Record<string, string>;
  rawBody: string;
  /** Parsed JSON body, or `null` when the body was not valid JSON. */
  json: unknown;
  /** ISO-8601 arrival time (mock clock). */
  receivedAt: string;
}

export interface MockCollector {
  /** Full collector URL — pass as the emitter's `endpoint`. */
  url: string;
  /** `http://127.0.0.1:<port>` */
  origin: string;
  port: number;
  /**
   * Every captured request, in arrival order. In `down` mode the attempt is
   * still captured (headers only, empty body) before the socket is killed.
   */
  requests: CapturedRequest[];
  /** The `events` arrays of every captured batch, in arrival order. */
  batches(): Envelope[][];
  /** All captured events across all batches, flattened. */
  events(): Envelope[];
  /** Script the next responses. Takes effect for requests arriving after the call. */
  setMode(mode: MockCollectorMode): void;
  /** Clear captured requests and restore `ok` mode. */
  reset(): void;
  /**
   * Resolve once at least `count` requests have been captured (immediately
   * if they already have been). Rejects after `timeoutMs` (default 2000).
   */
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  /** Stop the server, destroy open sockets, and settle pending waiters. Idempotent. */
  close(): Promise<void>;
}

interface Waiter {
  count: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Start a mock collector on a random loopback port. */
export async function startMockCollector(
  initialMode: MockCollectorMode = { kind: "ok" },
): Promise<MockCollector> {
  let mode = initialMode;
  let closed = false;
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const waiters: Waiter[] = [];

  const settleWaiters = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (requests.length >= waiters[i].count) {
        const [waiter] = waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };

  const server = http.createServer((request, response) => {
    if (mode.kind === "down") {
      // Capture the attempt, then kill the connection so the client sees a
      // socket-level failure instead of an HTTP response.
      requests.push(captureRequest(request, ""));
      settleWaiters();
      request.socket.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push(captureRequest(request, rawBody));
      settleWaiters();

      const respond = (status: number, body: string): void => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(body);
      };

      if (mode.kind === "slow") {
        const { delayMs, status } = mode;
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          respond(...contractResponse(rawBody, status));
        }, delayMs);
        pendingTimers.add(timer);
        return;
      }
      if (mode.kind === "status") {
        respond(mode.status, mode.body ?? "{}");
        return;
      }
      respond(...contractResponse(rawBody));
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const batches = (): Envelope[][] =>
    requests
      .map((captured) => extractEvents(captured.json))
      .filter((events): events is Envelope[] => events !== null);

  return {
    url: `${origin}${MOCK_COLLECTOR_PATH}`,
    origin,
    port,
    requests,
    batches,
    events(): Envelope[] {
      return batches().flat();
    },
    setMode(next: MockCollectorMode): void {
      mode = next;
    },
    reset(): void {
      requests.splice(0);
      mode = { kind: "ok" };
    },
    waitForRequests(count: number, timeoutMs = 2_000): Promise<void> {
      if (requests.length >= count) return Promise.resolve();
      if (closed) {
        return Promise.reject(new Error("mock collector is closed"));
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(
              new Error(
                `timed out waiting for ${count} request(s); ` +
                  `captured ${requests.length}`,
              ),
            );
          }, timeoutMs),
        };
        waiter.timer.unref?.();
        waiters.push(waiter);
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("mock collector closed while waiting"));
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

/**
 * The `ok`-mode response, approximating the collector contract:
 * 400 for an unparseable body, 413 for oversized batches, otherwise
 * `202 {"accepted":n,"dropped":0}`.
 */
function contractResponse(
  rawBody: string,
  statusOverride?: number,
): [number, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [statusOverride ?? 400, `{"error":"body is not valid JSON"}`];
  }
  const events = extractEvents(parsed);
  if (events !== null && events.length > MOCK_MAX_BATCH_EVENTS) {
    return [statusOverride ?? 413, `{"error":"too many events"}`];
  }
  const accepted = events === null ? 0 : events.length;
  return [statusOverride ?? 202, `{"accepted":${accepted},"dropped":0}`];
}

function extractEvents(body: unknown): Envelope[] | null {
  if (
    body !== null &&
    typeof body === "object" &&
    Array.isArray((body as { events?: unknown }).events)
  ) {
    return (body as { events: Envelope[] }).events;
  }
  return null;
}

function captureRequest(
  request: http.IncomingMessage,
  rawBody: string,
): CapturedRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    method: request.method ?? "",
    path: request.url ?? "",
    headers,
    rawBody,
    json: parseJsonOrNull(rawBody),
    receivedAt: new Date().toISOString(),
  };
}

function parseJsonOrNull(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
