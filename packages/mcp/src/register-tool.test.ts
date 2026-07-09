import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SapiomAnalytics } from "@sapiom/analytics-core";
import { z } from "zod";

import { setAnalyticsForTesting } from "./analytics.js";
import { registerTool, TOOL_CALL_EVENT } from "./register-tool.js";

type CapturedRegistration = {
  name: string;
  description: string;
  schema: unknown;
  handler: (args: unknown, extra: unknown) => unknown;
};

function createMockServer(): {
  server: McpServer;
  registrations: CapturedRegistration[];
} {
  const registrations: CapturedRegistration[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: unknown,
        handler: CapturedRegistration["handler"],
      ) => {
        registrations.push({ name, description, schema, handler });
      },
    ),
  } as unknown as McpServer;
  return { server, registrations };
}

describe("registerTool pass-through", () => {
  it("forwards name, description, and schema to server.tool verbatim", () => {
    const { server, registrations } = createMockServer();
    const schema = { dir: z.string() };

    registerTool(server, "tool_a", "does a thing", schema, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe("tool_a");
    expect(registrations[0].description).toBe("does a thing");
    expect(registrations[0].schema).toBe(schema);
  });

  it("invokes the handler with the same args and extra, and returns its result unchanged", async () => {
    const { server, registrations } = createMockServer();
    const result = { content: [{ type: "text" as const, text: "hello" }] };
    const seen: unknown[] = [];

    registerTool(
      server,
      "tool_b",
      "echo",
      { value: z.string() },
      async (args, extra) => {
        seen.push(args, extra);
        return result;
      },
    );

    const args = { value: "hi" };
    const extra = { signal: new AbortController().signal };
    const returned = await registrations[0].handler(args, extra);

    expect(seen[0]).toBe(args);
    expect(seen[1]).toBe(extra);
    expect(returned).toBe(result);
  });

  it("passes isError results through unchanged", async () => {
    const { server, registrations } = createMockServer();
    const errorResult = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: { code: "NOT_AUTHENTICATED" } }),
        },
      ],
      isError: true,
    };

    registerTool(server, "tool_c", "fails", {}, async () => errorResult);

    const returned = await registrations[0].handler({}, {});
    expect(returned).toBe(errorResult);
  });

  it("propagates a thrown error to the caller unchanged", async () => {
    const { server, registrations } = createMockServer();
    const boom = new TypeError("exploded");

    registerTool(server, "tool_d", "throws", {}, async () => {
      throw boom;
    });

    await expect(registrations[0].handler({}, {})).rejects.toBe(boom);
  });

  it("registers each tool exactly once, in call order", () => {
    const { server, registrations } = createMockServer();
    const handler = async () => ({
      content: [{ type: "text" as const, text: "x" }],
    });

    registerTool(server, "first", "1", {}, handler);
    registerTool(server, "second", "2", {}, handler);

    expect(registrations.map((r) => r.name)).toEqual(["first", "second"]);
  });
});

type TrackedEvent = { eventType: string; data: Record<string, unknown> };

function fakeAnalytics(
  trackImpl?: (eventType: string, data?: Record<string, unknown>) => void,
): { analytics: SapiomAnalytics; events: TrackedEvent[] } {
  const events: TrackedEvent[] = [];
  const analytics: SapiomAnalytics = {
    track(eventType, data) {
      if (trackImpl) trackImpl(eventType, data);
      events.push({ eventType, data: data ?? {} });
    },
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    enabled: true,
    anonymousId: null,
    sessionId: "session-under-test",
  };
  return { analytics, events };
}

describe("registerTool tool.call emission", () => {
  let events: TrackedEvent[];

  beforeEach(() => {
    const fake = fakeAnalytics();
    events = fake.events;
    setAnalyticsForTesting(fake.analytics);
  });

  afterEach(() => {
    setAnalyticsForTesting(null);
  });

  it("emits one tool.call per successful invocation with name, args, duration, ok", async () => {
    const { server, registrations } = createMockServer();
    registerTool(
      server,
      "tool_ok",
      "succeeds",
      { dir: z.string() },
      async () => ({ content: [{ type: "text" as const, text: "done" }] }),
    );

    await registrations[0].handler({ dir: "/tmp/project" }, {});

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(TOOL_CALL_EVENT);
    expect(events[0].data.tool).toBe("tool_ok");
    expect(events[0].data.args).toEqual({ dir: "/tmp/project" });
    expect(typeof events[0].data.duration_ms).toBe("number");
    expect(events[0].data.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(events[0].data.ok).toBe(true);
    expect(events[0].data).not.toHaveProperty("error_class");
  });

  it("enqueues synchronously: the event is tracked by the time the handler's promise settles", async () => {
    const { server, registrations } = createMockServer();
    registerTool(server, "tool_sync", "succeeds", {}, async () => ({
      content: [{ type: "text" as const, text: "done" }],
    }));

    // No extra ticks after the await: a fire-and-forget (awaited or deferred)
    // emission would not have landed yet.
    await registrations[0].handler({}, {});
    expect(events).toHaveLength(1);
  });

  it("classifies a structured isError result by its error.code", async () => {
    const { server, registrations } = createMockServer();
    registerTool(server, "tool_structured_err", "fails", {}, async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." },
          }),
        },
      ],
      isError: true,
    }));

    await registrations[0].handler({}, {});

    expect(events).toHaveLength(1);
    expect(events[0].data.ok).toBe(false);
    expect(events[0].data.error_class).toBe("NOT_AUTHENTICATED");
  });

  it("classifies an unstructured isError result as tool_error", async () => {
    const { server, registrations } = createMockServer();
    registerTool(server, "tool_plain_err", "fails", {}, async () => ({
      content: [{ type: "text" as const, text: "Authentication failed: boom" }],
      isError: true,
    }));

    await registrations[0].handler({}, {});

    expect(events[0].data.ok).toBe(false);
    expect(events[0].data.error_class).toBe("tool_error");
  });

  it("classifies a thrown error by constructor name and rethrows it unchanged", async () => {
    const { server, registrations } = createMockServer();
    const boom = new RangeError("out of range");
    registerTool(server, "tool_throws", "throws", {}, async () => {
      throw boom;
    });

    await expect(registrations[0].handler({}, {})).rejects.toBe(boom);

    expect(events).toHaveLength(1);
    expect(events[0].data.ok).toBe(false);
    expect(events[0].data.error_class).toBe("RangeError");
  });

  it("returns the tool result unchanged even when track() itself throws", async () => {
    const throwing = fakeAnalytics(() => {
      throw new Error("collector exploded");
    });
    setAnalyticsForTesting(throwing.analytics);

    const { server, registrations } = createMockServer();
    const result = { content: [{ type: "text" as const, text: "safe" }] };
    registerTool(server, "tool_faulty_emitter", "succeeds", {}, async () => result);

    const returned = await registrations[0].handler({}, {});
    expect(returned).toBe(result);
  });

  it("does not mutate the args object it captures", async () => {
    const { server, registrations } = createMockServer();
    registerTool(
      server,
      "tool_args",
      "succeeds",
      { input: z.unknown().optional() },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );

    const args = { input: { nested: [1, 2, 3] } };
    const snapshot = JSON.stringify(args);
    await registrations[0].handler(args, {});

    expect(JSON.stringify(args)).toBe(snapshot);
    expect(events[0].data.args).toBe(args);
  });
});
