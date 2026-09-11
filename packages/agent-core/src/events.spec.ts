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

    it("rejects a BigInt, naming its path", async () => {
      const { client, calls } = fakeClient();
      await expect(
        emitEvent({ type: "lead.created", payload: { amount: 10n } }, client),
      ).rejects.toMatchObject({
        code: "BAD_PAYLOAD",
        message: expect.stringContaining("`payload.amount`"),
      });
      // Without this the throw comes from JSON.stringify inside the client's
      // fetch try-block, which reports a payload problem as `NETWORK`.
      expect(calls).toEqual([]);
    });

    it.each([
      [
        "a self-reference",
        () => {
          const p: Record<string, unknown> = { a: 1 };
          p.self = p;
          return { payload: p, path: "payload.self" };
        },
      ],
      [
        "a cycle back to an ancestor",
        () => {
          const p: Record<string, any> = { a: { b: {} } };
          p.a.b.back = p.a;
          return { payload: p, path: "payload.a.b.back" };
        },
      ],
    ])("rejects %s rather than exhausting the stack", async (_label, build) => {
      const { client, calls } = fakeClient();
      const { payload, path } = build();
      // A RangeError here, not an AgentOperationError, is the regression this
      // guards: callers switch on `code`, and a stack overflow has none.
      await expect(
        emitEvent({ type: "lead.created", payload }, client),
      ).rejects.toMatchObject({
        code: "BAD_PAYLOAD",
        message: expect.stringContaining(`\`${path}\``),
      });
      expect(calls).toEqual([]);
    });

    it("allows the same object under two keys — a repeat is not a cycle", async () => {
      const { client, calls } = fakeClient();
      const shared = { id: "x" };
      await emitEvent(
        { type: "lead.created", payload: { from: shared, to: shared } },
        client,
      );
      // JSON writes it twice and round-trips fine; only an ancestor repeating
      // itself is a cycle.
      expect(calls).toHaveLength(1);
    });

    // A value defining `toJSON` is the serializer's business, not this walk's.
    // Validation must not invoke caller code: it would run the method twice
    // (here and in `JSON.stringify`), let a non-pure one send data this check
    // never saw, and force this code to reproduce the serializer's calling
    // convention — which it got wrong, because the real one passes the key.
    describe("toJSON is left to the serializer", () => {
      it("is never invoked by the preflight", async () => {
        const { client } = fakeClient();
        let invocations = 0;
        const payload = {
          s: {
            toJSON() {
              invocations += 1;
              return { n: invocations };
            },
          },
        };

        await emitEvent({ type: "lead.created", payload }, client);
        // The walk calls it zero times, so the only invocation left is the
        // serializer's — what is validated and what is sent cannot diverge.
        expect(invocations).toBe(0);
      });

      it("accepts a toJSON that uses the property key JSON hands it", async () => {
        const { client, calls } = fakeClient();
        const payload = {
          field: {
            toJSON(key: string) {
              return key.toUpperCase();
            },
          },
        };
        // Serializes cleanly; calling it with no argument threw instead.
        expect(JSON.stringify(payload)).toBe('{"field":"FIELD"}');

        await emitEvent({ type: "lead.created", payload }, client);
        expect(calls).toHaveLength(1);
      });

      it("accepts an object whose toJSON hides a cycle and a BigInt", async () => {
        const { client, calls } = fakeClient();
        class Entity {
          readonly big = 10n;
          parent: Entity = this;
          constructor(readonly id: string) {}
          toJSON() {
            return { id: this.id };
          }
        }
        const payload = { node: new Entity("n1") };
        // The serializer never sees the internals, so neither does the walk.
        expect(JSON.stringify(payload)).toBe('{"node":{"id":"n1"}}');

        await emitEvent({ type: "lead.created", payload }, client);
        expect(calls).toHaveLength(1);
      });

      // The deliberate gap, pinned so it is a decision rather than a surprise:
      // what a custom toJSON PRODUCES is beyond this check's reach, and
      // degrades to what every other verb in this SDK already does.
      it("does not catch a non-finite number that toJSON itself returns", async () => {
        const { client, calls } = fakeClient();
        const payload = {
          d: {
            toJSON() {
              return { n: Infinity };
            },
          },
        };
        expect(JSON.stringify(payload)).toBe('{"d":{"n":null}}');

        await emitEvent({ type: "lead.created", payload }, client);
        expect(calls).toHaveLength(1);
      });
    });

    // `.map` preserves holes, so the previous walk handed `for...of` an empty
    // slot and destructuring threw a raw TypeError on a payload the serializer
    // writes without complaint.
    describe("sparse arrays", () => {
      // Built by assignment rather than as `[1, , 3]` literals: eslint's
      // no-sparse-arrays forbids the literal form, and the hole is the point.
      const holeBetweenValues = (): unknown[] => {
        const items = [1];
        items[2] = 3;
        return items;
      };

      it.each([
        ["a fully sparse array", () => new Array(1), '{"items":[null]}'],
        ["a hole between values", holeBetweenValues, '{"items":[1,null,3]}'],
      ])("accepts %s, as JSON does", async (_label, build, wire) => {
        const { client, calls } = fakeClient();
        const payload = { items: build() };
        expect(JSON.stringify(payload)).toBe(wire);

        await emitEvent({ type: "lead.created", payload }, client);
        expect(calls).toHaveLength(1);
      });

      it("still reaches every index past a hole", async () => {
        const { client } = fakeClient();
        const items = new Array(2);
        items[1] = Infinity;

        await expect(
          emitEvent({ type: "lead.created", payload: { items } }, client),
        ).rejects.toMatchObject({
          code: "BAD_PAYLOAD",
          message: expect.stringContaining("`payload.items[1]`"),
        });
      });
    });

    it("leaves the values JSON transforms rather than corrupts", async () => {
      const { client, calls } = fakeClient();
      await emitEvent(
        {
          type: "lead.created",
          payload: {
            // toJSON: this is how a Date becomes an ISO string — the useful
            // result, not a corruption.
            occurredAt: new Date("2026-01-01T00:00:00.000Z"),
            // Dropped by JSON, like every other verb in this SDK: an absent key
            // cannot be told apart from one that was never set.
            absent: undefined,
          },
        },
        client,
      );
      expect(calls).toHaveLength(1);
      expect(
        JSON.parse(JSON.stringify((calls[0].body as any).payload)),
      ).toEqual({ occurredAt: "2026-01-01T00:00:00.000Z" });
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
