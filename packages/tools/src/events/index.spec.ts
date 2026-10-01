/**
 * events.emit: URL, body (id forwarded or omitted), receipt returned as is, non-2xx
 * surfaced as TransportHttpError with no retry. Injects a fake fetch (no real network).
 */
import { createClient } from "../index.js";
import { Transport, TransportHttpError } from "../_client/index.js";
import { emit, type EmitEventResult } from "./index.js";

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  status: number,
  body: unknown,
  calls: Captured[] = [],
): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

const MATCHED: EmitEventResult = {
  receiptId: "rcpt-1",
  outcome: "matched",
  duplicate: false,
  fireIds: ["fire-1", "fire-2"],
};

describe("events.emit", () => {
  it("POSTs { type, payload, id } to <base>/agents/v1/events", async () => {
    const calls: Captured[] = [];
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeFetch(202, MATCHED, calls),
    });

    await sapiom.events.emit({
      type: "lead.created",
      payload: { a: 1 },
      id: "evt-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/agents\/v1\/events$/);
    expect(calls[0].init.method).toBe("POST");
    expect(
      (calls[0].init.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
    expect(calls[0].init.body).toBe(
      '{"type":"lead.created","payload":{"a":1},"id":"evt-1"}',
    );
  });

  it("sends no id key when id is omitted", async () => {
    const calls: Captured[] = [];
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeFetch(202, MATCHED, calls),
    });

    await sapiom.events.emit({ type: "lead.created", payload: { a: 1 } });

    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toEqual({ type: "lead.created", payload: { a: 1 } });
    expect("id" in sent).toBe(false);
  });

  it.each<[string, EmitEventResult]>([
    ["matched", MATCHED],
    [
      "unmatched",
      {
        receiptId: "rcpt-2",
        outcome: "unmatched",
        duplicate: false,
        fireIds: [],
      },
    ],
    [
      "duplicate",
      { receiptId: "rcpt-1", outcome: "matched", duplicate: true, fireIds: [] },
    ],
  ])("returns the %s receipt unchanged", async (_label, receipt) => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeFetch(202, receipt),
    });

    await expect(
      sapiom.events.emit({ type: "lead.created", payload: {}, id: "evt-1" }),
    ).resolves.toEqual(receipt);
  });

  it.each([400, 429])(
    "rejects a %i with a TransportHttpError and does not retry",
    async (status) => {
      const calls: Captured[] = [];
      const sapiom = createClient({
        apiKey: "k",
        fetch: fakeFetch(status, { message: "nope" }, calls),
      });

      const err = await sapiom.events
        .emit({ type: "lead.created", payload: {} })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TransportHttpError);
      expect((err as TransportHttpError).status).toBe(status);
      expect(calls).toHaveLength(1);
    },
  );

  it("barrel emit with an explicit transport and base URL hits <base>/agents/v1/events", async () => {
    const calls: Captured[] = [];
    const transport = new Transport({
      apiKey: "k",
      fetch: fakeFetch(202, MATCHED, calls),
    });

    await emit(
      { type: "lead.created", payload: {} },
      transport,
      "https://agents.example",
    );

    expect(calls[0].url).toBe("https://agents.example/agents/v1/events");
  });
});
