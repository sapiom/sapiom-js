/**
 * watchExecution — the live SSE async-iterator. Tests drive a fake `fetch`
 * whose body is a `ReadableStream` of SSE frames, so the real `openStream` +
 * framing + teardown paths are exercised offline.
 */
import { createClient, type GatewayClient } from "./client.js";
import type { SseEvent } from "./types.js";
import { parseSseEvent, parseSseFrame, watchExecution } from "./watch.js";

// ── Fake SSE transport ─────────────────────────────────────────────────────────

/** A `ReadableStream` that emits the given string chunks then closes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });
}

/** Serialize one event as the engine's wire frame (`id`/`event`/`data`). */
function frame(id: string, ev: Record<string, unknown>): string {
  return `id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

const HEARTBEAT = "event: heartbeat\ndata: {}\n\n";

/** Mock global.fetch to return an SSE stream; records the init for assertions. */
function mockSseFetch(
  chunks: string[],
  status = 200,
): { calls: RequestInit[]; spy: jest.SpyInstance } {
  const ok = status >= 200 && status < 300;
  const calls: RequestInit[] = [];
  const spy = jest
    .spyOn(global, "fetch" as any)
    .mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as RequestInit;
      calls.push(init);
      return {
        ok,
        status,
        statusText: ok ? "OK" : "Error",
        body: ok ? streamOf(chunks) : null,
        text: async () => (ok ? "" : JSON.stringify({ message: "nope" })),
      } as unknown as Response;
    });
  return { calls, spy };
}

const EV_A = { type: "step.started", executionId: "e1", traceRoot: "t1", nodeId: "s1" };
const EV_B = { type: "run.terminal", executionId: "e1", traceRoot: "t1", nodeId: "e1" };

async function collect(iter: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

afterEach(() => jest.restoreAllMocks());

function client(): GatewayClient {
  return createClient({ host: "https://example.com", apiKey: "sk_test" });
}

// ── watchExecution ──────────────────────────────────────────────────────────────

describe("watchExecution", () => {
  it("yields live events, filtering heartbeats", async () => {
    mockSseFetch([frame("1", EV_A), HEARTBEAT, frame("2", EV_B)]);
    const events = await collect(watchExecution({ executionId: "e1" }, client()));
    expect(events).toEqual([
      { type: "step.started", executionId: "e1", traceRoot: "t1", nodeId: "s1" },
      { type: "run.terminal", executionId: "e1", traceRoot: "t1", nodeId: "e1" },
    ]);
  });

  it("reassembles a frame split across read chunks", async () => {
    const whole = frame("1", EV_A);
    const mid = Math.floor(whole.length / 2);
    mockSseFetch([whole.slice(0, mid), whole.slice(mid)]);
    const events = await collect(watchExecution({ executionId: "e1" }, client()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("step.started");
  });

  it("targets the run stream endpoint with the api key and accept header", async () => {
    const { calls, spy } = mockSseFetch([frame("1", EV_B)]);
    await collect(watchExecution({ executionId: "e 1/x" }, client()));
    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/v1/workflows/executions/e%201%2Fx/stream");
    const headers = calls[0].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk_test");
    expect(headers.accept).toBe("text/event-stream");
  });

  it("forwards lastEventId as the resume cursor", async () => {
    const { calls } = mockSseFetch([frame("5", EV_B)]);
    await collect(watchExecution({ executionId: "e1", lastEventId: "42" }, client()));
    const headers = calls[0].headers as Record<string, string>;
    expect(headers["last-event-id"]).toBe("42");
  });

  it("aborts the underlying fetch when the iterator is torn down early", async () => {
    // A stream that never closes on its own — only teardown can end it.
    const encoder = new TextEncoder();
    let aborted = false;
    jest
      .spyOn(global, "fetch" as any)
      .mockImplementation(async (...args: unknown[]) => {
        const init = args[1] as RequestInit;
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(frame("1", EV_A)));
          },
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
      });

    // Break after the first event — the generator's finally must abort the fetch.
    for await (const ev of watchExecution({ executionId: "e1" }, client())) {
      expect(ev.type).toBe("step.started");
      break;
    }
    expect(aborted).toBe(true);
  });

  it("throws AgentOperationError on a failed handshake", async () => {
    mockSseFetch([], 404);
    await expect(
      collect(watchExecution({ executionId: "missing" }, client())),
    ).rejects.toMatchObject({ code: "HTTP_404" });
  });
});

// ── frame parsing ───────────────────────────────────────────────────────────────

describe("parseSseFrame", () => {
  it("parses id/event/data into an SseEvent from the data payload", () => {
    expect(parseSseFrame(frame("9", EV_A).trimEnd())).toEqual({
      type: "step.started",
      executionId: "e1",
      traceRoot: "t1",
      nodeId: "s1",
    });
  });

  it("drops a heartbeat frame", () => {
    expect(parseSseFrame("event: heartbeat\ndata: {}")).toBeNull();
  });

  it("drops a comment/retry-only frame", () => {
    expect(parseSseFrame(": keep-alive\nretry: 3000")).toBeNull();
  });

  it("joins multi-line data before parsing", () => {
    const raw = 'data: {"type":"cost.updated",\ndata: "executionId":"e2","traceRoot":null,"nodeId":"n2"}';
    expect(parseSseFrame(raw)).toEqual({
      type: "cost.updated",
      executionId: "e2",
      traceRoot: null,
      nodeId: "n2",
    });
  });
});

describe("parseSseEvent", () => {
  it("narrows a valid payload", () => {
    expect(parseSseEvent(JSON.stringify(EV_B))?.type).toBe("run.terminal");
  });

  it("returns null for an unknown type, empty id, or malformed json", () => {
    expect(parseSseEvent('{"type":"bogus","executionId":"e1"}')).toBeNull();
    expect(parseSseEvent('{"type":"step.started","executionId":""}')).toBeNull();
    expect(parseSseEvent("{")).toBeNull();
    expect(parseSseEvent("{}")).toBeNull();
  });

  it("defaults optional ids to null", () => {
    expect(parseSseEvent('{"type":"run.paused","executionId":"e1"}')).toEqual({
      type: "run.paused",
      executionId: "e1",
      traceRoot: null,
      nodeId: null,
    });
  });
});
