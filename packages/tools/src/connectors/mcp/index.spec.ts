import { Transport, TransportHttpError } from "../../_client/index.js";
import { McpRelayError, mcp } from "./index.js";

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

/** What the relay's stateless StreamableHTTP transport answers with: one SSE event. */
function sseResponse(message: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Answer each JSON-RPC request with `result(params)` under the request's own id. */
function rpcHandler(
  result: (method: string, params: Record<string, unknown>) => unknown,
  frame: (m: unknown) => Response = sseResponse,
) {
  return (call: FetchCall) => {
    const req = bodyOf(call);
    return frame({
      jsonrpc: "2.0",
      id: req.id,
      result: result(req.method, req.params),
    });
  };
}

const TOOL = {
  name: "list_issues",
  description: "List issues",
  inputSchema: { type: "object", properties: { limit: { type: "number" } } },
};

describe("mcp relay connector", () => {
  it("listTools POSTs a JSON-RPC tools/list to the slug's relay with the MCP Accept header", async () => {
    const { transport, calls } = makeTransport([
      rpcHandler(() => ({ tools: [TOOL] })),
    ]);

    await expect(mcp("linear", transport).listTools()).resolves.toEqual([TOOL]);

    expect(calls[0]!.url).toBe(`${BASE}/connectors/v1/linear/mcp`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("sat_run-token");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // The relay's StreamableHTTP transport 406s unless both are accepted.
    expect(headerOf(calls[0]!, "accept")).toBe(
      "application/json, text/event-stream",
    );
    const req = bodyOf(calls[0]!);
    expect(req).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    expect(typeof req.id).toBe("number");
    // Stateless relay: no initialize round trip.
    expect(calls).toHaveLength(1);
  });

  it("listTools follows nextCursor until the last page", async () => {
    const second = { ...TOOL, name: "create_issue" };
    const { transport, calls } = makeTransport([
      rpcHandler((_m, params) =>
        params.cursor === "p2"
          ? { tools: [second] }
          : { tools: [TOOL], nextCursor: "p2" },
      ),
    ]);

    await expect(mcp("linear", transport).listTools()).resolves.toEqual([
      TOOL,
      second,
    ]);
    expect(calls.map((c) => bodyOf(c).params)).toEqual([{}, { cursor: "p2" }]);
  });

  it("callTool POSTs tools/call with name + arguments and returns the CallToolResult", async () => {
    const result = { content: [{ type: "text", text: "3 issues" }] };
    const { transport, calls } = makeTransport([rpcHandler(() => result)]);

    await expect(
      mcp("notion", transport).callTool("search", { query: "roadmap" }),
    ).resolves.toEqual(result);

    expect(calls[0]!.url).toBe(`${BASE}/connectors/v1/notion/mcp`);
    expect(bodyOf(calls[0]!)).toMatchObject({
      method: "tools/call",
      params: { name: "search", arguments: { query: "roadmap" } },
    });
  });

  it("callTool sends empty arguments when none are given", async () => {
    const { transport, calls } = makeTransport([
      rpcHandler(() => ({ content: [] })),
    ]);
    await mcp("linear", transport).callTool("list_teams");
    expect(bodyOf(calls[0]!).params).toEqual({
      name: "list_teams",
      arguments: {},
    });
  });

  it("returns a relay-reported tool failure as an isError result, not a throw", async () => {
    const failed = {
      content: [{ type: "text", text: "That tool is not available." }],
      isError: true,
    };
    const { transport } = makeTransport([rpcHandler(() => failed)]);
    await expect(
      mcp("linear", transport).callTool("nope", {}),
    ).resolves.toEqual(failed);
  });

  it("accepts a plain JSON response body as well as SSE", async () => {
    const { transport } = makeTransport([
      rpcHandler(
        () => ({ tools: [TOOL] }),
        (m) => jsonResponse(m),
      ),
    ]);
    await expect(mcp("linear", transport).listTools()).resolves.toEqual([TOOL]);
  });

  it("skips SSE events that are not the response to this request", async () => {
    const { transport } = makeTransport([
      (call) => {
        const id = bodyOf(call).id;
        return new Response(
          `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n` +
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [TOOL] } })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ]);
    await expect(mcp("linear", transport).listTools()).resolves.toEqual([TOOL]);
  });

  it("throws McpRelayError carrying the JSON-RPC error code and message", async () => {
    const { transport } = makeTransport([
      (call) =>
        sseResponse({
          jsonrpc: "2.0",
          id: bodyOf(call).id,
          error: {
            code: -32603,
            message: "The connector relay is temporarily unavailable.",
          },
        }),
    ]);

    const pending = mcp("linear", transport).listTools();
    await expect(pending).rejects.toBeInstanceOf(McpRelayError);
    await expect(mcp("linear", transport).listTools()).rejects.toMatchObject({
      code: -32603,
      message: "The connector relay is temporarily unavailable.",
      slug: "linear",
      method: "tools/list",
    });
  });

  it("throws McpRelayError when the body holds no JSON-RPC response", async () => {
    const { transport } = makeTransport([
      () =>
        new Response("<html>oops</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ]);
    await expect(mcp("linear", transport).listTools()).rejects.toMatchObject({
      name: "McpRelayError",
      code: -32700,
    });
  });

  it("surfaces a non-2xx (401 bad credential) as the transport's HTTP error with the body", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "tenant_identity_required" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const err = await mcp("linear", transport)
      .callTool("list_issues")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportHttpError);
    expect(err).toMatchObject({
      status: 401,
      body: { error: "tenant_identity_required" },
    });
    expect((err as Error).message).toMatch(/401.*tenant_identity_required/);
  });

  it("URL-encodes the slug", async () => {
    const { transport, calls } = makeTransport([
      rpcHandler(() => ({ tools: [] })),
    ]);
    await mcp("my connector", transport).listTools();
    expect(calls[0]!.url).toBe(`${BASE}/connectors/v1/my%20connector/mcp`);
  });
});
