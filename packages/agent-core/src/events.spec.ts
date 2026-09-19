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

      // Probing `value.toJSON` is itself a property read, so an object whose
      // `toJSON` is a GETTER ran it here and again in the serializer. One that
      // answered `undefined` first and a function second had the walk validate
      // the raw object while the serializer sent the projection.
      it("is detected without reading it, so a toJSON getter is never run here", async () => {
        const { client, calls } = fakeClient();
        let reads = 0;
        const tricky = {
          v: 10,
          get toJSON() {
            reads += 1;
            return reads === 1 ? undefined : () => 20;
          },
        };

        await emitEvent(
          { type: "lead.created", payload: { t: tricky } },
          client,
        );

        // Zero: the descriptor answers the question. Whatever JSON.stringify
        // does downstream is the same with or without this walk.
        expect(reads).toBe(0);
        expect(calls).toHaveLength(1);
      });

      it("still recognises a prototype toJSON, so a Date is left whole", async () => {
        const { client, calls } = fakeClient();
        // `Date.prototype.toJSON` is not an own property — a probe that only
        // looked at own descriptors would descend into the Date instead.
        await emitEvent(
          {
            type: "lead.created",
            payload: { at: new Date("2026-01-01T00:00:00.000Z") },
          },
          client,
        );
        expect(calls).toHaveLength(1);
        expect(
          JSON.parse(JSON.stringify((calls[0].body as any).payload)),
        ).toEqual({ at: "2026-01-01T00:00:00.000Z" });
      });

      it("does not treat a setter-only toJSON as a hook", async () => {
        const { client } = fakeClient();
        // Reading such a property yields `undefined`, so JSON.stringify walks
        // into the object normally. Calling it a hook made the whole object
        // opaque and let the Infinity below it through.
        const payload = { amount: Infinity, set toJSON(_value: unknown) {} };

        await expect(
          emitEvent({ type: "lead.created", payload }, client),
        ).rejects.toMatchObject({
          code: "BAD_PAYLOAD",
          message: expect.stringContaining("`payload.amount`"),
        });
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

    // A getter is caller code, like `toJSON`, and `JSON.stringify` reads the
    // property again on the way out. Reading it here too made that two reads,
    // so a getter that does not answer the same twice shipped a value the walk
    // never saw — including an `Infinity` that sailed past the check below it.
    describe("getters are left to the serializer", () => {
      it("is not invoked by the preflight, so validated and sent cannot diverge", async () => {
        const { client, calls } = fakeClient();
        let reads = 0;
        const payload = {
          get n() {
            reads += 1;
            return reads === 1 ? 10 : 20;
          },
        };

        await emitEvent({ type: "lead.created", payload }, client);

        // Zero reads from the walk: the serializer downstream is the only one.
        expect(reads).toBe(0);
        expect(calls).toHaveLength(1);
      });

      it("does not report a non-finite number a getter would produce", async () => {
        const { client, calls } = fakeClient();
        const payload = {
          get n() {
            return Infinity;
          },
        };
        // The documented edge of this check: it stops at code it does not run.
        await emitEvent({ type: "lead.created", payload }, client);
        expect(calls).toHaveLength(1);
      });

      it("still checks the plain data properties beside a getter", async () => {
        const { client } = fakeClient();
        const payload = {
          get lazy() {
            return "fine";
          },
          amount: Infinity,
        };
        await expect(
          emitEvent({ type: "lead.created", payload }, client),
        ).rejects.toMatchObject({
          code: "BAD_PAYLOAD",
          message: expect.stringContaining("`payload.amount`"),
        });
      });
    });

    it("gives up quietly when the payload is nested deeper than the stack", async () => {
      const { client, calls } = fakeClient();
      let node: Record<string, unknown> = {};
      const root = node;
      for (let depth = 0; depth < 50_000; depth += 1) {
        node.next = {};
        node = node.next as Record<string, unknown>;
      }

      // The walk recurses, so this used to escape as a raw `RangeError` —
      // outside the `AgentOperationError` contract the CLI and MCP normalize.
      // A check that cannot complete stops; it never becomes the reason an
      // emit fails. (The serializer downstream reports its own failure in the
      // client's structured shape.)
      await emitEvent({ type: "lead.created", payload: root }, client);
      expect(calls).toHaveLength(1);
    });

    // Reflection is caller code once a Proxy is involved: the traps below run
    // on `Object.getOwnPropertyDescriptor`, `Object.getPrototypeOf` and
    // `Object.keys`, none of which `JSON.stringify` needs. Every one of them
    // fails opaque, so a payload the serializer handles is never rejected —
    // and an unbounded prototype chain can no longer spin.
    describe("proxies cannot steer the walk", () => {
      it("terminates on a prototype chain that reports itself", async () => {
        const { client, calls } = fakeClient();
        const looping: object = new Proxy(
          {},
          { getPrototypeOf: () => looping },
        );

        // Before the visited-set guard this spun forever, blocking the thread
        // outright rather than answering — a hang, not a slow answer.
        await emitEvent(
          { type: "lead.created", payload: { v: looping } },
          client,
        );
        expect(calls).toHaveLength(1);
      });

      it("does not reject a payload whose descriptor trap throws", async () => {
        const { client, calls } = fakeClient();
        const hostile = new Proxy(
          {},
          {
            get: (_t, key) =>
              key === "toJSON" ? () => ({ id: 1 }) : undefined,
            getOwnPropertyDescriptor() {
              throw new Error("trap boom");
            },
          },
        );
        // It serializes perfectly well; only the preflight's reflection trips.
        expect(JSON.stringify({ v: hostile })).toBe('{"v":{"id":1}}');

        await emitEvent(
          { type: "lead.created", payload: { v: hostile } },
          client,
        );
        expect(calls).toHaveLength(1);
      });

      it("does not reject a payload whose ownKeys trap throws", async () => {
        const { client, calls } = fakeClient();
        const hostile = new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("keys boom");
            },
          },
        );
        await emitEvent(
          { type: "lead.created", payload: { v: hostile } },
          client,
        );
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

      // A hole is not free on the wire: the serializer writes `null` for every
      // slot up to `length`, so an array holding NOTHING still becomes
      // megabytes. At 50 million that measured 250 MB and a quarter of a
      // billion characters, and further up the process dies before `fetch` —
      // which is why this cannot be left to the server's 413 to answer.
      it("rejects a length that cannot fit the body however few elements it holds", async () => {
        const { client, calls } = fakeClient();
        const items: unknown[] = [];
        items.length = 50_000_000;

        await expect(
          emitEvent({ type: "lead.created", payload: { items } }, client),
        ).rejects.toMatchObject({
          code: "BAD_PAYLOAD",
          message: expect.stringContaining("`payload.items`"),
        });
        expect(calls).toEqual([]);
      });

      // The bound is a floor, so nothing the server would have accepted is
      // refused here: an element costs at least one character plus a comma.
      it.each([
        ["just inside the floor", 131_071, true],
        ["just past it", 131_072, false],
      ])("%s", async (_label, length, sendable) => {
        // Serializes for real, so the test exercises the path that allocates
        // rather than a fake that only records the object.
        const seen: number[] = [];
        const client = {
          post: async (_path: string, body: { payload: unknown }) => {
            seen.push(JSON.stringify(body.payload).length);
            return RECEIPT;
          },
        } as unknown as GatewayClient;
        const items: unknown[] = [];
        items.length = length;

        const emit = emitEvent(
          { type: "lead.created", payload: { items } },
          client,
        );
        if (sendable) {
          await emit;
          expect(seen).toHaveLength(1);
        } else {
          await expect(emit).rejects.toMatchObject({ code: "BAD_PAYLOAD" });
          expect(seen).toEqual([]);
        }
      });

      it("still checks the indices a mostly-sparse array does hold", async () => {
        const { client } = fakeClient();
        const items: unknown[] = [];
        items.length = 100_000;
        items[99_999] = Infinity;

        // Enumeration is bounded by content, so the one real value is found
        // without touching the 99,999 holes before it.
        await expect(
          emitEvent({ type: "lead.created", payload: { items } }, client),
        ).rejects.toMatchObject({
          code: "BAD_PAYLOAD",
          message: expect.stringContaining("`payload.items[99999]`"),
        });
      });

      it("checks a non-enumerable index, which JSON serializes anyway", async () => {
        const { client } = fakeClient();
        const items = [1];
        Object.defineProperty(items, 0, {
          value: Infinity,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        // JSON writes every index up to `length` regardless of enumerability,
        // so `Object.keys` asks the wrong question for an array: it returned
        // nothing here and the Infinity shipped as `null`.
        expect(Object.keys(items)).toEqual([]);
        expect(JSON.stringify({ items })).toBe('{"items":[null]}');

        await expect(
          emitEvent({ type: "lead.created", payload: { items } }, client),
        ).rejects.toMatchObject({
          code: "BAD_PAYLOAD",
          message: expect.stringContaining("`payload.items[0]`"),
        });
      });

      // A slot is read the way any property lookup is, so a hole over a
      // prototype that defines that index serializes the INHERITED value, not
      // `null`. Own names alone missed those.
      it.each([
        ["a non-finite number", Infinity, '{"items":[null]}'],
        ["a BigInt", 10n, null],
      ])(
        "checks an index the prototype supplies: %s",
        async (_label, value, wire) => {
          const { client } = fakeClient();
          const items = new Array(1);
          Object.setPrototypeOf(items, { 0: value });
          expect(Object.getOwnPropertyNames(items)).toEqual(["length"]);
          // Infinity ships as a null the sender never wrote; a BigInt makes the
          // serializer throw, which surfaces as a NETWORK error for what is
          // entirely a payload fault.
          if (wire !== null) expect(JSON.stringify({ items })).toBe(wire);
          else expect(() => JSON.stringify({ items })).toThrow();

          await expect(
            emitEvent({ type: "lead.created", payload: { items } }, client),
          ).rejects.toMatchObject({
            code: "BAD_PAYLOAD",
            message: expect.stringContaining("`payload.items[0]`"),
          });
        },
      );

      it("lets an own index shadow the prototype's", async () => {
        const { client, calls } = fakeClient();
        const items = [1];
        Object.setPrototypeOf(items, { 0: Infinity });
        // The own value is what serializes, so the inherited one is not a fault.
        expect(JSON.stringify({ items })).toBe('{"items":[1]}');

        await emitEvent({ type: "lead.created", payload: { items } }, client);
        expect(calls).toHaveLength(1);
      });

      it("ignores a prototype index past the array's length", async () => {
        const { client, calls } = fakeClient();
        const items = new Array(1);
        Object.setPrototypeOf(items, { 5: Infinity });
        expect(JSON.stringify({ items })).toBe('{"items":[null]}');

        await emitEvent({ type: "lead.created", payload: { items } }, client);
        expect(calls).toHaveLength(1);
      });

      it("ignores a key past the last real array index", async () => {
        const { client, calls } = fakeClient();
        const items: unknown[] = [];
        // An index stops at 2^32 - 2, so this is an ordinary property: `length`
        // stays 0 and the serializer drops it.
        items[4_294_967_295] = Infinity;
        expect(items.length).toBe(0);
        expect(JSON.stringify({ items })).toBe('{"items":[]}');

        await emitEvent({ type: "lead.created", payload: { items } }, client);
        expect(calls).toHaveLength(1);
      });

      it("ignores an array's non-index key, which JSON drops anyway", async () => {
        const { client, calls } = fakeClient();
        const items: unknown[] & { note?: unknown } = [1];
        items.note = Infinity;
        // `JSON.stringify` writes `[1]` — flagging `note` would reject a
        // payload over a value that never reaches the wire.
        expect(JSON.stringify({ items })).toBe('{"items":[1]}');

        await emitEvent({ type: "lead.created", payload: { items } }, client);
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
