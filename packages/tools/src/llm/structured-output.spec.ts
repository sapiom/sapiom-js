/**
 * llm.run's structured-output convenience (`spec.output`) and the `textOf` /
 * `structuredOf` extraction helpers — the automated form of the blessed
 * tool-calling pattern for a single routed call.
 */
import { createClient } from "../index.js";
import {
  LlmStructuredOutputMissingError,
  LlmStructuredOutputTruncatedError,
  structuredOf,
  textOf,
} from "./index.js";

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

const TOOL_CALL_RESPONSE = {
  content: [{ type: "tool_use", name: "record_person", input: { name: "Priya", age: 34 } }],
};

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
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, TOOL_CALL_RESPONSE) });
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
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, TOOL_CALL_RESPONSE) });
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
    // success, and the caller destructures `undefined` out of a partial object.
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
    expect(error.missingPath).toBe("priority");
    expect(error.message).toContain("is incomplete");
    expect(error.message).toContain('missing the required field "priority"');
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

  it("throws for an empty input at the cap when the schema requires anything", async () => {
    // The cut landed before the first key was written. The path is the first required key,
    // because that is the first thing the walk finds absent.
    const cutMidInput = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "classify_ticket", input: {} }],
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
    expect(error.missingPath).toBe("priority");
  });

  it("returns an empty input at the cap when the schema requires nothing", async () => {
    // `{}` is a complete result for a schema with no required properties, and a tool call
    // can finish exactly at the ceiling. Incompleteness is decided by the schema, not by
    // how many keys came back.
    const completion = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", name: "classify_ticket", input: {} }],
    };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
    const res = await sapiom.llm.run({
      request: { messages: [{ role: "user", content: "classify" }], max_tokens: 256 },
      output: {
        name: "classify_ticket",
        schema: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false },
      },
    });

    expect(structuredOf(res, "classify_ticket")).toEqual({});
  });

  describe("a cut inside a nested field", () => {
    // A root-only check reads `{ result: {} }` as complete. The schema is walked to every
    // depth because the cap lands wherever the model happened to be writing.
    const NESTED_SCHEMA = {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: { priority: { type: "string" }, note: { type: "string" } },
          required: ["priority"],
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, score: { type: "number" } },
            required: ["name", "score"],
          },
        },
      },
      required: ["result"],
    };

    const runNested = (input: Record<string, unknown>, max_tokens = 256) => {
      const completion = {
        stop_reason: "max_tokens",
        content: [{ type: "tool_use", name: "classify_ticket", input }],
      };
      const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
      return sapiom.llm.run({
        request: { messages: [{ role: "user", content: "classify" }], max_tokens },
        output: { name: "classify_ticket", schema: NESTED_SCHEMA },
      });
    };

    it("throws when a nested object is missing a required field, naming the nested path", async () => {
      const error = await runNested({ result: {} }).catch((err: unknown) => err as LlmStructuredOutputTruncatedError);
      expect(error).toBeInstanceOf(LlmStructuredOutputTruncatedError);
      expect(error.reason).toBe("incomplete-input");
      expect(error.missingPath).toBe("result.priority");
      expect(error.message).toContain('missing the required field "result.priority"');
    });

    it("throws when an array element is missing a required field, naming the element", async () => {
      const error = await runNested({
        result: { priority: "high" },
        items: [{ name: "a", score: 1 }, { name: "b" }],
      }).catch((err: unknown) => err as LlmStructuredOutputTruncatedError);
      expect(error).toBeInstanceOf(LlmStructuredOutputTruncatedError);
      expect(error.reason).toBe("incomplete-input");
      expect(error.missingPath).toBe("items[1].score");
    });

    it("returns a complete nested input that happened to end at the cap", async () => {
      const input = { result: { priority: "high" }, items: [{ name: "a", score: 1 }] };
      const res = await runNested(input, 4096);
      expect(structuredOf(res, "classify_ticket")).toEqual(input);
    });

    it("does not read an omitted OPTIONAL nested field, or an omitted optional array, as truncation", async () => {
      const input = { result: { priority: "high" } };
      const res = await runNested(input);
      expect(structuredOf(res, "classify_ticket")).toEqual(input);
    });

    it("judges anyOf by the branch the input satisfies, and allOf by every branch", async () => {
      const completion = (input: Record<string, unknown>) => ({
        stop_reason: "max_tokens",
        content: [{ type: "tool_use", name: "classify_ticket", input }],
      });
      const schema = {
        type: "object",
        properties: {
          verdict: {
            anyOf: [
              { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"] },
              { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
            ],
          },
          meta: {
            allOf: [
              { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
              { type: "object", properties: { at: { type: "string" } }, required: ["at"] },
            ],
          },
        },
        required: ["verdict", "meta"],
      };
      const run = (input: Record<string, unknown>) =>
        createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion(input)) }).llm.run({
          request: { messages: [{ role: "user", content: "judge" }], max_tokens: 256 },
          output: { name: "classify_ticket", schema },
        });

      const ok = { verdict: { reason: "too long" }, meta: { id: "1", at: "now" } };
      expect(structuredOf(await run(ok), "classify_ticket")).toEqual(ok);

      const noBranch = await run({ verdict: {}, meta: { id: "1", at: "now" } }).catch(
        (err: unknown) => err as LlmStructuredOutputTruncatedError,
      );
      expect(noBranch.reason).toBe("incomplete-input");
      expect(noBranch.missingPath).toBe("verdict.pass");

      const halfAllOf = await run({ verdict: { pass: true }, meta: { id: "1" } }).catch(
        (err: unknown) => err as LlmStructuredOutputTruncatedError,
      );
      expect(halfAllOf.reason).toBe("incomplete-input");
      expect(halfAllOf.missingPath).toBe("meta.at");
    });

    it("follows a local $ref into $defs and definitions, at a property and inside array items", async () => {
      // The gateway validates the referenced schema as part of input_schema, so the walk
      // has to see the same requirements the model was held to.
      const schema = {
        $defs: {
          result: { type: "object", properties: { priority: { type: "string" } }, required: ["priority"] },
        },
        definitions: {
          item: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
        type: "object",
        properties: {
          result: { $ref: "#/$defs/result" },
          items: { type: "array", items: { $ref: "#/definitions/item" } },
        },
        required: ["result"],
      };
      const run = (input: Record<string, unknown>) => {
        const completion = {
          stop_reason: "max_tokens",
          content: [{ type: "tool_use", name: "classify_ticket", input }],
        };
        return createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) }).llm.run({
          request: { messages: [{ role: "user", content: "classify" }], max_tokens: 256 },
          output: { name: "classify_ticket", schema },
        });
      };

      const viaDefs = await run({ result: {} }).catch((err: unknown) => err as LlmStructuredOutputTruncatedError);
      expect(viaDefs).toBeInstanceOf(LlmStructuredOutputTruncatedError);
      expect(viaDefs.missingPath).toBe("result.priority");

      const viaDefinitions = await run({ result: { priority: "high" }, items: [{ name: "a" }, {}] }).catch(
        (err: unknown) => err as LlmStructuredOutputTruncatedError,
      );
      expect(viaDefinitions).toBeInstanceOf(LlmStructuredOutputTruncatedError);
      expect(viaDefinitions.missingPath).toBe("items[1].name");

      const complete = { result: { priority: "high" }, items: [{ name: "a" }] };
      expect(structuredOf(await run(complete), "classify_ticket")).toEqual(complete);
    });

    it("stops on a $ref cycle instead of recursing forever, and still judges the input", async () => {
      // `a` → `b` → `a` consumes no input between hops; the walk follows each reference once
      // per position and then reads the requirements it found.
      const schema = {
        $defs: {
          a: { $ref: "#/$defs/b" },
          b: { $ref: "#/$defs/a", type: "object", properties: { child: { $ref: "#/$defs/a" } }, required: ["value"] },
        },
        $ref: "#/$defs/a",
      };
      const run = (input: Record<string, unknown>) => {
        const completion = {
          stop_reason: "max_tokens",
          content: [{ type: "tool_use", name: "classify_ticket", input }],
        };
        return createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) }).llm.run({
          request: { messages: [{ role: "user", content: "classify" }], max_tokens: 256 },
          output: { name: "classify_ticket", schema },
        });
      };

      const deep = await run({ value: 1, child: { value: 2, child: {} } }).catch(
        (err: unknown) => err as LlmStructuredOutputTruncatedError,
      );
      expect(deep).toBeInstanceOf(LlmStructuredOutputTruncatedError);
      expect(deep.missingPath).toBe("child.child.value");

      const complete = { value: 1, child: { value: 2 } };
      expect(structuredOf(await run(complete), "classify_ticket")).toEqual(complete);
    });

    it("leaves an external $ref unresolved: no network, so no requirements are read from it", async () => {
      const schema = {
        type: "object",
        properties: { result: { $ref: "https://example.com/schemas/result.json#/definitions/result" } },
        required: ["result"],
      };
      const completion = {
        stop_reason: "max_tokens",
        content: [{ type: "tool_use", name: "classify_ticket", input: { result: {} } }],
      };
      const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
      const res = await sapiom.llm.run({
        request: { messages: [{ role: "user", content: "classify" }], max_tokens: 256 },
        output: { name: "classify_ticket", schema },
      });
      expect(structuredOf(res, "classify_ticket")).toEqual({ result: {} });
    });

    it("leaves a nested gap alone when the turn did not end at the cap", async () => {
      // The compatibility boundary: this is a truncation detector, not a schema validator.
      const completion = {
        stop_reason: "end_turn",
        content: [{ type: "tool_use", name: "classify_ticket", input: { result: {} } }],
      };
      const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
      const res = await sapiom.llm.run({
        request: { messages: [{ role: "user", content: "classify" }], max_tokens: 4096 },
        output: { name: "classify_ticket", schema: NESTED_SCHEMA },
      });
      expect(structuredOf(res, "classify_ticket")).toEqual({ result: {} });
    });
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

  it("does not throw the truncation error for a turn that ended without the tool call", async () => {
    // Not truncated, so this is the missing-call error's case, not the cap's.
    const completion = { stop_reason: "end_turn", content: [{ type: "text", text: "I could not classify it" }] };
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, completion) });
    const error = await sapiom.llm
      .run({
        request: { messages: [{ role: "user", content: "classify" }], max_tokens: 4096 },
        output: { name: "classify_ticket", schema: SCHEMA },
      })
      .catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(LlmStructuredOutputTruncatedError);
    expect(error).toBeInstanceOf(LlmStructuredOutputMissingError);
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

/**
 * SAP-3782: a forced tool call the model skipped on a turn that was NOT cut off by the cap
 * (Sylon copilot execution 848839). `structuredOf` returned `undefined` and the step carried on
 * with nothing.
 */
describe("llm.run — a structured call whose turn ended without the tool call", () => {
  const SCHEMA = {
    type: "object",
    properties: { priority: { type: "string" } },
    required: ["priority"],
  };
  const skipped = {
    id: "msg_1",
    type: "message",
    model: "medium",
    stop_reason: "end_turn",
    served_class: "medium",
    lane: "run_now",
    content: [
      { type: "thinking", thinking: "weighing an ambiguous ticket…" },
      { type: "text", text: "Here is my classification." },
    ],
  };

  const runWith = (response: Record<string, unknown>) =>
    createClient({ apiKey: "k", fetch: fakeDirectFetch({}, response) }).llm.run({
      request: { messages: [{ role: "user", content: "classify" }], max_tokens: 4096 },
      output: { name: "classify_ticket", schema: SCHEMA },
    });

  it("throws LlmStructuredOutputMissingError for end_turn with only thinking and text blocks", async () => {
    await expect(runWith(skipped)).rejects.toBeInstanceOf(LlmStructuredOutputMissingError);
  });

  it("carries the stop reason, served class, model, tool name, block types and raw response", async () => {
    const error = await runWith(skipped).catch((err: unknown) => err as LlmStructuredOutputMissingError);
    expect(error.name).toBe("LlmStructuredOutputMissingError");
    expect(error.outputName).toBe("classify_ticket");
    expect(error.stopReason).toBe("end_turn");
    expect(error.servedClass).toBe("medium");
    expect(error.model).toBe("medium");
    expect(error.blockTypes).toEqual(["thinking", "text"]);
    expect(error.response).toEqual(skipped);
    expect(error.message).toContain('the model did not call the "classify_ticket" tool');
    expect(error.message).toContain("stop_reason: end_turn");
    expect(error.message).toContain("content blocks: thinking, text");
  });

  it("throws when the only tool_use block is for a different tool", async () => {
    const error = await runWith({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "other_tool", input: { x: 1 } }],
    }).catch((err: unknown) => err as LlmStructuredOutputMissingError);
    expect(error).toBeInstanceOf(LlmStructuredOutputMissingError);
    expect(error.blockTypes).toEqual(["tool_use"]);
  });

  it("tolerates a response with no content, stop_reason or disclosure", async () => {
    const error = await runWith({}).catch((err: unknown) => err as LlmStructuredOutputMissingError);
    expect(error).toBeInstanceOf(LlmStructuredOutputMissingError);
    expect(error.stopReason).toBeUndefined();
    expect(error.servedClass).toBeNull();
    expect(error.blockTypes).toEqual([]);
  });

  it("still throws the truncation error, not this one, for max_tokens with no tool call", async () => {
    const error = await runWith({ ...skipped, stop_reason: "max_tokens" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LlmStructuredOutputTruncatedError);
    expect(error).not.toBeInstanceOf(LlmStructuredOutputMissingError);
  });

  it("returns the response when the tool call arrived", async () => {
    const completion = {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "…" },
        { type: "tool_use", name: "classify_ticket", input: { priority: "high" } },
      ],
    };
    expect(structuredOf(await runWith(completion), "classify_ticket")).toEqual({ priority: "high" });
  });

  it("does not apply to a call without `output`", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch({}, skipped) });
    const res = await sapiom.llm.run({ request: { messages: [{ role: "user", content: "hi" }], max_tokens: 64 } });
    expect(textOf(res)).toBe("Here is my classification.");
  });
});
