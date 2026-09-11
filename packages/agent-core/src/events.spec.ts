/**
 * events core fns — assert `emitEvent` builds the right method + path + body against the
 * `/v1/workflows` base, and that `parseEventPayload` refuses what the run-input fold would
 * silently drop. The GatewayClient is faked to record calls.
 */
import type { GatewayClient } from "./client.js";
import { asEventPayload, emitEvent, parseEventPayload } from "./events.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const RECEIPT = {
  receiptId: "rcpt-1",
  outcome: "matched" as const,
  duplicate: false,
  fireIds: ["fire-1", "fire-2"],
};

function fakeClient(response: unknown = RECEIPT): {
  client: GatewayClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    post: async (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return response;
    },
  } as unknown as GatewayClient;
  return { client, calls };
}

describe("emitEvent", () => {
  it("POSTs /events with the type and payload", async () => {
    const { client, calls } = fakeClient();
    await emitEvent(
      { type: "lead.created", payload: { leadId: "l_42" } },
      client,
    );
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/events",
      body: { type: "lead.created", payload: { leadId: "l_42" } },
    });
  });

  it("sends eventId under its wire name, `id`", async () => {
    const { client, calls } = fakeClient();
    await emitEvent(
      { type: "lead.created", payload: {}, eventId: "crm-evt-8f2a" },
      client,
    );
    expect(calls[0].body).toEqual({
      type: "lead.created",
      payload: {},
      id: "crm-evt-8f2a",
    });
  });

  it("omits the `id` key entirely when no eventId is given (the server mints one)", async () => {
    const { client, calls } = fakeClient();
    await emitEvent({ type: "lead.created", payload: {} }, client);
    // Not `id: undefined` — the route's validation pipe rejects undeclared
    // fields, and absent is what lets the server mint the dedup id.
    expect(Object.keys(calls[0].body as object)).toEqual(["type", "payload"]);
  });

  it("returns the receipt verbatim", async () => {
    const { client } = fakeClient();
    await expect(
      emitEvent({ type: "lead.created", payload: {} }, client),
    ).resolves.toEqual(RECEIPT);
  });

  // `EmitEventOptions` binds TypeScript callers, but this ships as a published
  // package and a JS caller reaches the same function with nothing to stop them.
  // The server rejects these too, so the value here is the local, named error
  // instead of a round-trip and an opaque HTTP_400.
  it.each([
    ["an array", [{ leadId: "l_42" }]],
    ["a scalar", 42],
    ["a string", "lead.created"],
    ["null", null],
    ["undefined", undefined],
  ])(
    "rejects %s passed straight to emitEvent, before the wire",
    async (_label, payload) => {
      const { client, calls } = fakeClient();
      await expect(
        emitEvent({ type: "lead.created", payload: payload as never }, client),
      ).rejects.toMatchObject({ code: "BAD_PAYLOAD" });
      expect(calls).toEqual([]);
    },
  );

  // `JSON.stringify` turns a non-finite number into `null`, so the server's own
  // non-finite rejection would see a null and pass it — the receipt records a
  // value the sender never wrote. This has to fail before serialization.
  describe("non-finite numbers", () => {
    it.each([
      ["Infinity at the top level", { amount: Infinity }, "payload.amount"],
      ["-Infinity", { amount: -Infinity }, "payload.amount"],
      ["NaN", { amount: NaN }, "payload.amount"],
      [
        "a nested value",
        { invoice: { total: Infinity } },
        "payload.invoice.total",
      ],
      ["an array entry", { totals: [1, Infinity] }, "payload.totals[1]"],
      [
        "a value nested under an array",
        { rows: [{ n: 1 }, { n: NaN }] },
        "payload.rows[1].n",
      ],
    ])("rejects %s, naming its path", async (_label, payload, path) => {
      const { client, calls } = fakeClient();
      await expect(
        emitEvent({ type: "lead.created", payload }, client),
      ).rejects.toMatchObject({
        code: "BAD_PAYLOAD",
        message: expect.stringContaining(`\`${path}\``),
      });
      // Nothing left the process: the point is to fail before the wire.
      expect(calls).toEqual([]);
    });

    it("rejects a non-finite number parsed from JSON text (1e400 is not an error)", async () => {
      const { client } = fakeClient();
      const payload = parseEventPayload('{"amount":1e400}');
      expect(payload.amount).toBe(Infinity);
      await expect(
        emitEvent({ type: "lead.created", payload }, client),
      ).rejects.toMatchObject({ code: "BAD_PAYLOAD" });
    });

    it("allows the finite edges JSON can carry", async () => {
      const { client, calls } = fakeClient();
      await emitEvent(
        {
          type: "lead.created",
          payload: {
            zero: 0,
            negative: -1.5,
            big: Number.MAX_SAFE_INTEGER,
            nested: { list: [1, 2, 3] },
            nulls: null,
            text: "1e400",
          },
        },
        client,
      );
      expect(calls).toHaveLength(1);
    });
  });

  it("passes `unmatched` and `duplicate` through without treating either as an error", async () => {
    const { client } = fakeClient({
      receiptId: "rcpt-2",
      outcome: "unmatched",
      duplicate: true,
      fireIds: [],
    });
    const result = await emitEvent(
      { type: "lead.craeted", payload: {}, eventId: "retry-1" },
      client,
    );
    expect(result).toEqual({
      receiptId: "rcpt-2",
      outcome: "unmatched",
      duplicate: true,
      fireIds: [],
    });
  });
});

describe("parseEventPayload", () => {
  it("parses a JSON object", () => {
    expect(parseEventPayload('{"leadId":"l_42"}')).toEqual({ leadId: "l_42" });
  });

  it("accepts an empty object", () => {
    expect(parseEventPayload("{}")).toEqual({});
  });

  it("throws BAD_PAYLOAD on invalid JSON", () => {
    expect(() => parseEventPayload("{nope")).toThrow(
      expect.objectContaining({ code: "BAD_PAYLOAD" }),
    );
  });

  // Each of these is valid JSON, so only the object check catches it — and the
  // run-input fold treats a non-object as absent, i.e. starts a run with the
  // data dropped. Fail at the call site instead.
  it.each([
    ["an array", "[1,2]"],
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"lead.created"'],
    ["a boolean", "true"],
  ])("throws BAD_PAYLOAD on %s", (_label, raw) => {
    expect(() => parseEventPayload(raw)).toThrow(
      expect.objectContaining({ code: "BAD_PAYLOAD" }),
    );
  });
});

describe("asEventPayload", () => {
  it("passes a plain object through", () => {
    const payload = { leadId: "l_42" };
    expect(asEventPayload(payload)).toBe(payload);
  });

  it("accepts an empty object", () => {
    expect(asEventPayload({})).toEqual({});
  });

  // The value form of the same rule `parseEventPayload` applies to a string —
  // for callers that already hold a decoded value (an MCP tool argument).
  it.each([
    ["an array", [1, 2]],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "lead.created"],
    ["a boolean", true],
  ])("throws BAD_PAYLOAD on %s", (_label, value) => {
    expect(() => asEventPayload(value)).toThrow(
      expect.objectContaining({ code: "BAD_PAYLOAD" }),
    );
  });
});
