import { Transport, attributionFromEnv, type Attribution } from "./index.js";
import { capabilityCall } from "./capability-call.js";

// Mirrors capability-call.spec's fetch-capture harness, but with attribution set on the
// Transport — proving the trace context is forwarded ONCE at the single choke point
// (`Transport.fetch`), so every capability inherits it with no per-tool wiring.
interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeTransport(attribution: Attribution): {
  transport: Transport;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    transport: new Transport({ apiKey: "k", fetch: fetchMock, attribution }),
    calls,
  };
}

const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];
const makeError = (m: string): Error => new Error(m);

const call = (transport: Transport) =>
  capabilityCall(
    "web.scrape",
    { url: "https://example.com" },
    { transport, baseUrl: "https://api.test", makeError, errorPrefix: "x" },
  );

describe("Attribution → forwarded x-sapiom-* headers (once, all capabilities)", () => {
  it("forwards traceId/parentSpanId/executionId/stepOrder on every capability call", async () => {
    const { transport, calls } = makeTransport({
      traceId: "core-1",
      activityTraceId: "act-1",
      parentSpanId: "s1",
      executionId: "e1",
      stepOrder: 3,
    });

    await call(transport);

    // Core transaction trace and activity trace ride SEPARATE headers — they never collide.
    expect(headerOf(calls[0]!, "x-sapiom-trace-id")).toBe("core-1");
    expect(headerOf(calls[0]!, "x-sapiom-activity-trace-id")).toBe("act-1");
    expect(headerOf(calls[0]!, "x-sapiom-parent-span-id")).toBe("s1");
    expect(headerOf(calls[0]!, "x-sapiom-execution-id")).toBe("e1");
    expect(headerOf(calls[0]!, "x-sapiom-step-order")).toBe("3");
  });

  it("emits step-order '0' — the first step is a valid ordinal, not omitted", async () => {
    const { transport, calls } = makeTransport({ stepOrder: 0 });

    await call(transport);

    expect(headerOf(calls[0]!, "x-sapiom-step-order")).toBe("0");
  });

  it("omits headers for absent fields", async () => {
    const { transport, calls } = makeTransport({ traceId: "t1" });

    await call(transport);

    expect(headerOf(calls[0]!, "x-sapiom-trace-id")).toBe("t1");
    expect(headerOf(calls[0]!, "x-sapiom-parent-span-id")).toBeUndefined();
    expect(headerOf(calls[0]!, "x-sapiom-execution-id")).toBeUndefined();
    expect(headerOf(calls[0]!, "x-sapiom-step-order")).toBeUndefined();
  });
});

describe("attributionFromEnv (in-sandbox ambient channel)", () => {
  const saved = process.env;
  beforeEach(() => {
    process.env = { ...saved };
    for (const k of [
      "SAPIOM_TRACE_ID",
      "SAPIOM_ACTIVITY_TRACE_ID",
      "SAPIOM_PARENT_SPAN_ID",
      "SAPIOM_EXECUTION_ID",
      "SAPIOM_STEP_ORDER",
      "SAPIOM_TRACE_EXTERNAL_ID",
      "SAPIOM_AGENT_ID",
      "SAPIOM_AGENT_NAME",
    ]) {
      delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = saved;
  });

  it("reads the trace env vars, including step-order 0", () => {
    process.env.SAPIOM_TRACE_ID = "core-1";
    process.env.SAPIOM_ACTIVITY_TRACE_ID = "act-1";
    process.env.SAPIOM_PARENT_SPAN_ID = "s1";
    process.env.SAPIOM_EXECUTION_ID = "e1";
    process.env.SAPIOM_STEP_ORDER = "0";

    expect(attributionFromEnv()).toEqual({
      traceId: "core-1",
      activityTraceId: "act-1",
      parentSpanId: "s1",
      executionId: "e1",
      stepOrder: 0,
    });
  });

  it("omits absent fields and ignores a non-numeric step-order", () => {
    expect(attributionFromEnv()).toEqual({});

    process.env.SAPIOM_STEP_ORDER = "not-a-number";
    expect(attributionFromEnv().stepOrder).toBeUndefined();
  });
});
