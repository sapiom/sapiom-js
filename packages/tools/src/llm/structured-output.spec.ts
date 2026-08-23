/**
 * llm.run's structured-output convenience (`spec.output`) and the `textOf` /
 * `structuredOf` extraction helpers — the automated form of the blessed
 * tool-calling pattern for a single routed call.
 */
import { createClient } from "../index.js";
import { structuredOf, textOf } from "./index.js";

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
