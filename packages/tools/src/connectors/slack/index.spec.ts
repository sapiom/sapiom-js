import { Transport } from "../../_client/index.js";
import * as slack from "./index.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeTransport(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  apiKey: string | undefined = "sat_run-token",
): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = await handler({ url, init });
      if (response) return response;
    }
    throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
  }) as typeof globalThis.fetch;
  return { transport: new Transport({ apiKey, fetch: fetchMock }), calls };
}

const BASE = "https://tools.sapiom.ai";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

const bodyOf = (c: FetchCall) => JSON.parse(c.init.body as string);

describe("slack methods", () => {
  it("postMessage POSTs chat.postMessage on x-sapiom-api-key with threadTs as given", async () => {
    const result = { ok: true, channel: "C1", ts: "1.2" };
    const { transport, calls } = makeTransport([() => jsonResponse(result)]);

    const args = { channel: "C1", text: "hi", threadTs: "1.1" };
    await expect(slack.postMessage(args, transport)).resolves.toEqual(result);

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/slack/methods/chat.postMessage`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("sat_run-token");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // The gateway reads chat.postMessage's thread as `threadTs`.
    expect(bodyOf(calls[0]!)).toEqual(args);
  });

  it("postEphemeral sends the thread as thread_ts, the gateway's name for this method", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ok: true, message_ts: "1.3" }),
    ]);

    await slack.postEphemeral(
      { channel: "C1", user: "U1", text: "only you", threadTs: "1.1" },
      transport,
    );

    expect(calls[0]!.url).toBe(
      `${BASE}/connectors/v1/slack/methods/chat.postEphemeral`,
    );
    expect(bodyOf(calls[0]!)).toEqual({
      channel: "C1",
      user: "U1",
      text: "only you",
      thread_ts: "1.1",
    });
  });

  it("postEphemeral omits thread_ts when no thread is given", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ ok: true, message_ts: "1.3" }),
    ]);

    await slack.postEphemeral(
      { channel: "C1", user: "U1", text: "x" },
      transport,
    );

    expect(bodyOf(calls[0]!)).toEqual({ channel: "C1", user: "U1", text: "x" });
  });

  it.each([
    [
      "update",
      "chat.update",
      { channel: "C1", ts: "1.2", blocks: [{ type: "divider" }] },
    ],
    [
      "addReaction",
      "reactions.add",
      { channel: "C1", timestamp: "1.2", name: "eyes" },
    ],
    [
      "removeReaction",
      "reactions.remove",
      { channel: "C1", timestamp: "1.2", name: "eyes" },
    ],
    [
      "replies",
      "conversations.replies",
      { channel: "C1", ts: "1.1", cursor: "c2", limit: 50 },
    ],
    ["userInfo", "users.info", { user: "U1" }],
  ] as const)(
    "%s POSTs methods/%s with the args unchanged and returns Slack's body",
    async (fn, method, args) => {
      const result = { ok: true, extra: "passed through" };
      const { transport, calls } = makeTransport([() => jsonResponse(result)]);

      const call = slack[fn] as (
        a: typeof args,
        t: Transport,
      ) => Promise<unknown>;
      await expect(call(args, transport)).resolves.toEqual(result);

      expect(calls[0]!.url).toBe(
        `${BASE}/connectors/v1/slack/methods/${method}`,
      );
      expect(calls[0]!.init.method).toBe("POST");
      expect(bodyOf(calls[0]!)).toEqual(args);
    },
  );

  it("surfaces a 404 (no Slack connector for this tenant) with the connector_not_found body", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "connector_not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(
      slack.postMessage({ channel: "C1", text: "x" }, transport),
    ).rejects.toThrow(/404.*connector_not_found/);
  });

  it("surfaces a 502 when Slack answers ok: false", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({
            error: "connector_method_upstream_failed",
            message: "Slack users.info failed (user_not_found)",
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
    ]);
    await expect(slack.userInfo({ user: "U0" }, transport)).rejects.toThrow(
      /502.*user_not_found/,
    );
  });
});
