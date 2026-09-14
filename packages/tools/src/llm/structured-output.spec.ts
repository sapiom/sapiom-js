/**
 * llm.run's structured-output convenience (`spec.output`) and the `textOf` /
 * `structuredOf` extraction helpers — the automated form of the blessed
 * tool-calling pattern for a single routed call.
 */
import { createClient } from "../index.js";
import { LlmStructuredOutputTruncatedError, structuredOf, textOf } from "./index.js";

interface Captured {
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

function fakeDirectFetch(cap: Captured, response: Record<string, unknown>): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit = {}) => {
    cap.url = url;
    cap.headers = init.headers as Record<string, string>;
    cap.body = init.body as string;
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("textOf", () => {
  it("extracts the text block", () => {
    const response = { content: [{ type: "text", text: "hello" }] };
    expect(textOf(response)).toBe("hello");
  });

  it("skips a thinking block ahead of the text block", () => {
    const response = {
      content: [
        { type: "thinking", thinking: "reasoning about the answer…" },
        { type: "text", text: "the answer" },
      ],
    };
    expect(textOf(response)).toBe("the answer");
  });

  it("returns undefined when there is no text block (e.g. a pure tool-use turn)", () => {
    const response = { content: [{ type: "tool_use", name: "record", input: {} }] };
    expect(textOf(response)).toBeUndefined();
  });

  it("returns undefined for a malformed or missing response, never throws", () => {
    expect(textOf(null)).toBeUndefined();
    expect(textOf(undefined)).toBeUndefined();
    expect(textOf({})).toBeUndefined();
    expect(textOf({ content: "not an array" })).toBeUndefined();
  });
});

describe("structuredOf", () => {
  it("extracts the tool_use block's input", () => {
    const response = {
      content: [{ type: "tool_use", name: "record_person", input: { name: "Priya", age: 34 } }],
    };
    expect(structuredOf(response)).toEqual({ name: "Priya", age: 34 });
  });

  it("disambiguates by tool name when more than one tool_use block is present", () => {
    const response = {
      content: [
        { type: "tool_use", name: "other_tool", input: { wrong: true } },
        { type: "tool_use", name: "record_person", input: { name: "Priya" } },
      ],
    };
    expect(structuredOf(response, "record_person")).toEqual({ name: "Priya" });
  });

  it("returns undefined when no tool_use block matches", () => {
    const response = { content: [{ type: "text", text: "no tool call here" }] };
    expect(structuredOf(response)).toBeUndefined();
    expect(structuredOf(response, "record_person")).toBeUndefined();
  });
});

describe("llm.run — structured-output convenience (spec.output)", () => {
  const SCHEMA = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
  };

  it("injects the tool + forces tool_choice, appended to any caller-declared tools", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, { ok: true }) });
    await sapiom.llm.run({
      request: {
        messages: [{ role: "user", content: "extract the person" }],
        max_tokens: 256,
        tools: [{ name: "unrelated_tool", input_schema: { type: "object" } }],
      },
      output: { name: "record_person", schema: SCHEMA },
    });
    const body = JSON.parse(cap.body ?? "{}");
    expect(body.tools).toEqual([
      { name: "unrelated_tool", input_schema: { type: "object" } },
      { name: "record_person", input_schema: SCHEMA },
    ]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "record_person" });
  });

  it("does not mutate the caller's original request object", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, { ok: true }) });
    const request = { messages: [{ role: "user", content: "extract" }], max_tokens: 256 };
    await sapiom.llm.run({ request, output: { name: "record_person", schema: SCHEMA } });
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
  });

  it("leaves the request untouched, and the response type unchanged, when output is omitted", async () => {
    const cap: Captured = {};
    const completion = { id: "msg_1", type: "message", content: [{ type: "text", text: "hi" }] };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, completion) });
    const request = { messages: [{ role: "user", content: "hi" }], max_tokens: 64 };
    const res = await sapiom.llm.run({ request });
    expect(JSON.parse(cap.body ?? "{}")).toEqual(request);
    expect(res).toEqual(completion);
  });

  it("round-trips end to end: structuredOf reads the value out of the returned response", async () => {
    const cap: Captured = {};
    const completion = {
      id: "msg_1",
      type: "message",
      content: [{ type: "tool_use", name: "record_person", input: { name: "Priya", age: 34 } }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "extract" }], max_tokens: 256 },
      output: { name: "record_person", schema: SCHEMA },
    });
    expect(structuredOf<{ name: string; age: number }>(res, "record_person")).toEqual({
      name: "Priya",
      age: 34,
    });
  });
});

describe("ctx.sapiom.llm.{structuredOf,textOf,readDisclosure} — reachable from the client", () => {
  const SCHEMA = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
  };

  it("structuredOf works the same way through the client as the bare module import", async () => {
    const cap: Captured = {};
    const completion = {
      id: "msg_1",
      type: "message",
      content: [{ type: "tool_use", name: "record_person", input: { name: "Priya", age: 34 } }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "extract" }], max_tokens: 256 },
      output: { name: "record_person", schema: SCHEMA },
    });
    expect(sapiom.llm.structuredOf<{ name: string; age: number }>(res, "record_person")).toEqual({
      name: "Priya",
      age: 34,
    });
  });

  it("textOf works through the client", async () => {
    const cap: Captured = {};
    const completion = { id: "msg_1", type: "message", content: [{ type: "text", text: "hi" }] };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "hi" }], max_tokens: 64 },
    });
    expect(sapiom.llm.textOf(res)).toBe("hi");
  });

  it("readDisclosure works through the client", async () => {
    const cap: Captured = {};
    const completion = { id: "msg_1", type: "message", served_class: "medium", lane: "run_now" };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "hi" }], max_tokens: 64 },
    });
    expect(sapiom.llm.readDisclosure(res)).toEqual({ servedClass: "medium", lane: "run_now" });
  });
});

/**
 * The silent failure this error exists to end (SAP-3280): a routed label emits a
 * `thinking` block before the forced tool call, thinking is spent out of `max_tokens`,
 * and a cap sized for the answer alone ends the turn before the tool call is emitted.
 * `structuredOf` then correctly returns `undefined` and the author sees a `TypeError`
 * from destructuring it — indistinguishable from a genuinely empty result.
 */
describe("llm.run — a structured call truncated before its tool call", () => {
  const SCHEMA = {
    type: "object",
    properties: { priority: { type: "string" } },
    required: ["priority"],
  };
  const truncated = {
    id: "msg_1",
    type: "message",
    stop_reason: "max_tokens",
    content: [{ type: "thinking", thinking: "weighing an ambiguous ticket…" }],
  };

  const runTruncated = (max_tokens?: number) => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, truncated) });
    return sapiom.llm.run({
      request: { messages: [{ role: "user", content: "classify" }], ...(max_tokens === undefined ? {} : { max_tokens }) },
      output: { name: "classify_ticket", schema: SCHEMA },
    });
  };

  it("throws instead of returning a response whose tool call never arrived", async () => {
    await expect(runTruncated(256)).rejects.toBeInstanceOf(LlmStructuredOutputTruncatedError);
  });

  it("names the cap, the tool, and the fix, and carries the raw response", async () => {
    // The message is the whole point: the author's next move is to raise the cap.
    const error = await runTruncated(256).catch((err: unknown) => err as LlmStructuredOutputTruncatedError);
    expect(error.outputName).toBe("classify_ticket");
    expect(error.maxTokens).toBe(256);
    expect(error.reason).toBe("no-tool-call");
    expect(error.response).toEqual(truncated);
    expect(error.message).toContain("max_tokens (256)");
    expect(error.message).toContain("Thinking tokens count against max_tokens");
  });

  it("throws when the cap landed mid-input, leaving a required field unwritten", async () => {
    // The same failure one token later: the block is there, so a presence check reads it as
    // success, and the caller destructures `undefined` out of a partial object. The input is
    // deliberately NON-empty — an empty one short-circuits on the emptiness check above and
    // would leave the `required` branch this test is named for unexercised.
    const cutMidInput = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "classify_ticket", input: { note: "partial" } }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, cutMidInput) });
    const error = await sapiom.llm
      .run({
        request: { messages: [{ role: "user", content: "classify" }], max_tokens: 256 },
        output: { name: "classify_ticket", schema: SCHEMA },
      })
      .catch((err: unknown) => err as LlmStructuredOutputTruncatedError);

    expect(error).toBeInstanceOf(LlmStructuredOutputTruncatedError);
    expect(error.reason).toBe("incomplete-input");
    expect(error.message).toContain("is incomplete");
  });

  it("does not read an omitted OPTIONAL field as truncation", async () => {
    // Only the schema's `required` fields are evidence; the rest are the model's to omit.
    const completion = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "classify_ticket", input: { priority: "high" } }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "classify" }], max_tokens: 4096 },
      output: {
        name: "classify_ticket",
        schema: { ...SCHEMA, properties: { priority: { type: "string" }, note: { type: "string" } } },
      },
    });

    expect(structuredOf(res, "classify_ticket")).toEqual({ priority: "high" });
  });

  it("reads an empty input at the cap as truncation even with nothing required", async () => {
    // Without this, a schema that lists no `required` fields has no evidence to fail on, and
    // the mid-input cut goes back to being silent — the exact hole the error exists to close.
    const cutMidInput = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "classify_ticket", input: {} }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, cutMidInput) });
    const error = await sapiom.llm
      .run({
        request: { messages: [{ role: "user", content: "classify" }], max_tokens: 256 },
        output: { name: "classify_ticket", schema: { type: "object", properties: {} } },
      })
      .catch((err: unknown) => err as LlmStructuredOutputTruncatedError);

    expect(error).toBeInstanceOf(LlmStructuredOutputTruncatedError);
    expect(error.reason).toBe("incomplete-input");
  });

  it("leaves a partial result alone when the turn did not end at the cap", async () => {
    // A missing required field with any other stop_reason is the model's answer, not a
    // truncation — judging it would make this a schema validator, which it is not.
    const completion = {
      stop_reason: "end_turn",
      content: [{ type: "tool_use", name: "classify_ticket", input: {} }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "classify" }], max_tokens: 4096 },
      output: { name: "classify_ticket", schema: SCHEMA },
    });

    expect(structuredOf(res, "classify_ticket")).toEqual({});
  });

  it("still throws when the request declared no cap of its own", async () => {
    const error = await runTruncated().catch((err: unknown) => err as LlmStructuredOutputTruncatedError);
    expect(error).toBeInstanceOf(LlmStructuredOutputTruncatedError);
    expect(error.maxTokens).toBeUndefined();
  });

  it("does not throw when the tool call DID arrive, cap or no cap", async () => {
    // `stop_reason: "max_tokens"` with the tool call present is a complete structured
    // result that happened to end at the ceiling — nothing to report.
    const completion = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "classify_ticket", input: { priority: "high" } }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "classify" }], max_tokens: 4096 },
      output: { name: "classify_ticket", schema: SCHEMA },
    });
    expect(structuredOf(res, "classify_ticket")).toEqual({ priority: "high" });
  });

  it("does not throw for an empty structured result that was not truncated", async () => {
    // The other half of the distinction the error draws: a turn that ended for any
    // other reason is the caller's to judge, exactly as before.
    const completion = { stop_reason: "end_turn", content: [{ type: "text", text: "I could not classify it" }] };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "classify" }], max_tokens: 4096 },
      output: { name: "classify_ticket", schema: SCHEMA },
    });
    expect(structuredOf(res, "classify_ticket")).toBeUndefined();
  });

  it("leaves a truncated PLAIN-TEXT call alone — no `output`, nothing forced", async () => {
    // A text turn that hit the cap is truncated but still readable, so it stays the
    // caller's call. Throwing there would break every deliberately-bounded reply.
    const completion = { stop_reason: "max_tokens", content: [{ type: "text", text: "partial…" }] };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "write" }], max_tokens: 64 },
    });
    expect(textOf(res)).toBe("partial…");
  });
});
