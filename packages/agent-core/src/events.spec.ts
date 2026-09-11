/**
 * events core fns — assert `emitEvent` builds the right method + path + body against the
 * `/v1/workflows` base, and that `parseEventPayload` refuses what the run-input fold would
 * silently drop. The GatewayClient is faked to record calls.
 */
import type { GatewayClient } from "./client.js";
import { emitEvent, parseEventPayload } from "./events.js";

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
