/**
 * `sapiom_dev_agents_emit_event` — the start verb, next to `sapiom_dev_agents_signal`'s
 * resume verb. The tool is a passthrough, so what is worth holding is the passthrough
 * itself: args reach `emitEvent` verbatim, the receipt comes back verbatim, and the two
 * non-error outcomes (`unmatched`, `duplicate`) are NOT reported as failures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

// Keep the real module (AgentOperationError, createClient, ...) but stub the one
// networked fn, so the tool is tested without touching the backend.
vi.mock("@sapiom/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sapiom/agent-core")>();
  return { ...actual, emitEvent: vi.fn() };
});

import { register } from "./agents.js";
import { readCredentials } from "../credentials.js";
import { AgentOperationError, emitEvent } from "@sapiom/agent-core";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: any, handler: ToolHandler) => {
        handlers.set(_name, handler);
      },
    ),
  } as unknown as McpServer;
  return { server, handlers };
}

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const parse = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0].text);

const authed = () =>
  vi.mocked(readCredentials).mockResolvedValue({
    apiKey: "sk_test",
    tenantId: "t-1",
    organizationName: "Org",
    apiKeyId: "k-1",
  } as never);

describe("sapiom_dev_agents_emit_event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authed();
  });

  it("is registered", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    expect(handlers.has("sapiom_dev_agents_emit_event")).toBe(true);
  });

  it("forwards type, payload and eventId to emitEvent and returns the receipt", async () => {
    vi.mocked(emitEvent).mockResolvedValue({
      receiptId: "rcpt-1",
      outcome: "matched",
      duplicate: false,
      fireIds: ["fire-1", "fire-2"],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "lead.created",
      payload: { leadId: "l_42" },
      eventId: "crm-evt-8f2a",
    });

    expect(vi.mocked(emitEvent).mock.calls[0][0]).toEqual({
      type: "lead.created",
      payload: { leadId: "l_42" },
      eventId: "crm-evt-8f2a",
    });
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toEqual({
      receiptId: "rcpt-1",
      outcome: "matched",
      duplicate: false,
      fireIds: ["fire-1", "fire-2"],
    });
  });

  it("decodes a payload a client serialized as a JSON string", async () => {
    vi.mocked(emitEvent).mockResolvedValue({
      receiptId: "rcpt-1",
      outcome: "matched",
      duplicate: false,
      fireIds: ["fire-1"],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "lead.created",
      payload: '{"leadId":"l_42"}',
    });

    expect(vi.mocked(emitEvent).mock.calls[0][0].payload).toEqual({
      leadId: "l_42",
    });
  });

  // `payload` advertises as not-required in `tools/list` (z.unknown()), so the
  // handler has to honor an omission rather than contradict its own schema.
  it("defaults an omitted payload to {} — the advertised schema says it is optional", async () => {
    vi.mocked(emitEvent).mockResolvedValue({
      receiptId: "rcpt-1",
      outcome: "matched",
      duplicate: false,
      fireIds: ["fire-1"],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "heartbeat.tick",
    });

    expect(res.isError).toBeUndefined();
    expect(vi.mocked(emitEvent).mock.calls[0][0]).toEqual({
      type: "heartbeat.tick",
      payload: {},
      eventId: undefined,
    });
  });

  it.each([
    ["an array", [1, 2]],
    ["a scalar", 42],
    ["null", null],
    ["a non-JSON string", "lead.created"],
  ])(
    "rejects %s as a payload — the run-input fold would drop it silently",
    async (_label, payload) => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const res = await handlers.get("sapiom_dev_agents_emit_event")!({
        type: "lead.created",
        payload,
      });

      expect(res.isError).toBe(true);
      expect(parse(res).error.code).toBe("BAD_PAYLOAD");
      expect(emitEvent).not.toHaveBeenCalled();
    },
  );

  it("passes an omitted eventId through as undefined (the server mints the dedup id)", async () => {
    vi.mocked(emitEvent).mockResolvedValue({
      receiptId: "rcpt-2",
      outcome: "matched",
      duplicate: false,
      fireIds: ["fire-1"],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "lead.created",
      payload: {},
    });

    expect(vi.mocked(emitEvent).mock.calls[0][0]).toEqual({
      type: "lead.created",
      payload: {},
      eventId: undefined,
    });
  });

  it("reports `unmatched` as a success — nothing subscribed is not a failure", async () => {
    vi.mocked(emitEvent).mockResolvedValue({
      receiptId: "rcpt-3",
      outcome: "unmatched",
      duplicate: false,
      fireIds: [],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "lead.craeted",
      payload: {},
    });

    expect(res.isError).toBeUndefined();
    expect(parse(res).outcome).toBe("unmatched");
  });

  it("reports a duplicate as a success carrying the original receipt", async () => {
    vi.mocked(emitEvent).mockResolvedValue({
      receiptId: "rcpt-1",
      outcome: "matched",
      duplicate: true,
      fireIds: [],
    } as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "lead.created",
      payload: {},
      eventId: "crm-evt-8f2a",
    });

    expect(res.isError).toBeUndefined();
    expect(parse(res)).toMatchObject({ duplicate: true, fireIds: [] });
  });

  it("returns NOT_AUTHENTICATED without a cached credential, and never calls the route", async () => {
    vi.mocked(readCredentials).mockResolvedValue(null as never);
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "lead.created",
      payload: {},
    });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("NOT_AUTHENTICATED");
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("shapes a gateway error as the structured envelope (the reserved-namespace 400)", async () => {
    vi.mocked(emitEvent).mockRejectedValue(
      new AgentOperationError({
        code: "HTTP_400",
        message: 'Event type "sapiom.x" is reserved.',
      }),
    );
    const { server, handlers } = createMockServer();
    register(server, env);

    const res = await handlers.get("sapiom_dev_agents_emit_event")!({
      type: "sapiom.x",
      payload: {},
    });

    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatchObject({
      code: "HTTP_400",
      message: 'Event type "sapiom.x" is reserved.',
    });
  });
});
