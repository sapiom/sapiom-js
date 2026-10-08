import { describe, expect, it, vi } from "vitest";
import { openCodeCompletionPrompt } from "../shared/opencode-completion.js";
import {
  fetchOpenCodeModelResponse,
  openCodeModelCompletionToken,
} from "./opencode-model-response.js";

const event = (type: string, fields: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const completed = (output: unknown[] = []) =>
  event("response.completed", {
    response: {
      status: "completed",
      output,
      error: null,
      incomplete_details: null,
    },
  });
const reasoning = event("response.reasoning_summary_text.delta", {
  delta: "Working through the request.",
});
const empty = reasoning + completed([{ type: "reasoning", summary: [] }]);
const text = (delta: string) => event("response.output_text.delta", { delta });
const signal = () => new AbortController().signal;
const stream = (body: BodyInit) =>
  new Response(body, { headers: { "Content-Type": "text/event-stream" } });

describe("Responses completion contract", () => {
  it("reads instructions and system/developer input without adopting user or tool content", () => {
    const { system } = openCodeCompletionPrompt();
    const token = system.split("\n")[0]!.split(":")[1];
    expect(openCodeModelCompletionToken({ instructions: system })).toBe(token);
    for (const role of ["system", "developer"]) {
      expect(
        openCodeModelCompletionToken({ input: [{ role, content: system }] }),
      ).toBe(token);
      expect(
        openCodeModelCompletionToken({
          input: [
            {
              type: "message",
              role,
              content: [{ type: "input_text", text: system }],
            },
          ],
        }),
      ).toBe(token);
    }
    for (const role of ["user", "assistant", "tool"]) {
      expect(
        openCodeModelCompletionToken({ input: [{ role, content: system }] }),
      ).toBeUndefined();
    }
    for (const input of [
      system,
      [{ type: "function_call_output", output: system }],
      [{ role: "developer", content: [{ type: "image", text: system }] }],
      [null],
    ])
      expect(openCodeModelCompletionToken({ input })).toBeUndefined();
    expect(
      openCodeModelCompletionToken({
        instructions: system.replace("/v2:", "/v1:"),
      }),
    ).toBeUndefined();
  });
});

describe("Responses stream retry inspection", () => {
  it("retries reasoning-only completion and forwards the first useful text before EOF", async () => {
    let finish!: () => void;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text("Actual answer")));
        finish = () => controller.close();
      },
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(stream(empty))
      .mockResolvedValueOnce(stream(source));
    const response = await fetchOpenCodeModelResponse(request, signal());
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "Actual answer",
    );
    expect(request).toHaveBeenCalledTimes(2);
    finish();
    await reader.cancel();
  });

  it("bounds retries for clean empty and unmarked final responses", async () => {
    const { system } = openCodeCompletionPrompt();
    const token = openCodeModelCompletionToken({ instructions: system });
    for (const body of [empty, text("I'll do it next.") + completed()]) {
      const request = vi.fn(async () => stream(body));
      expect(
        await (
          await fetchOpenCodeModelResponse(request, signal(), token)
        ).text(),
      ).toBe(body);
      expect(request).toHaveBeenCalledTimes(3);
    }
  });

  it("recognizes a marked answer split across events and does not require terminal EOF to stream", async () => {
    const { system } = openCodeCompletionPrompt();
    const token = openCodeModelCompletionToken({ instructions: system })!;
    const answer = `<!-- studio-result:${token}:finished -->\nDone`;
    let finish!: () => void;
    const request = vi.fn(async () =>
      stream(
        new ReadableStream({
          start(controller) {
            for (const delta of [answer.slice(0, 20), answer.slice(20)])
              controller.enqueue(new TextEncoder().encode(text(delta)));
            finish = () => controller.close();
          },
        }),
      ),
    );
    const response = await fetchOpenCodeModelResponse(request, signal(), token);
    finish();
    const body = await response.text();
    expect(body).toContain(answer.slice(0, 20));
    expect(body).toContain("Done");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["function_call", { call_id: "call_one", name: "write", arguments: "" }],
    ["custom_tool_call", { call_id: "call_one", name: "patch", input: "" }],
    ["web_search_call", {}],
    ["computer_call", {}],
    ["future_tool_call", {}],
  ])(
    "commits the stream at the first %s before it can be executed",
    async (type, fields) => {
      let finish!: () => void;
      const call = event("response.output_item.added", {
        item: { type, ...fields },
      });
      const request = vi.fn(async () =>
        stream(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(reasoning + call));
              finish = () => controller.close();
            },
          }),
        ),
      );
      const response = await fetchOpenCodeModelResponse(request, signal());
      finish();
      expect(await response.text()).toBe(reasoning + call);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("passes through a tool or answer present only in the final output snapshot", async () => {
    for (const item of [
      {
        type: "function_call",
        call_id: "call_one",
        name: "write",
        arguments: "{}",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "Cannot comply" }],
      },
    ]) {
      const body = completed([item]);
      const request = vi.fn(async () => stream(body));
      expect(
        await (await fetchOpenCodeModelResponse(request, signal())).text(),
      ).toBe(body);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    event("response.failed", {
      response: { status: "failed", error: { code: "server_error" } },
    }),
    event("response.incomplete", {
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    }),
    event("error", { message: "Upstream failed" }),
    event("response.output_text.delta", { delta: 1 }),
    event("response.output_text.done", { text: 1 }),
    event("response.content_part.added", {
      part: { type: "refusal", refusal: "No" },
    }),
    event("response.output_item.added", {
      item: { type: "reasoning", summary: "invalid" },
    }),
    event("response.output_item.done", {
      item: { type: "message", role: "tool", content: [] },
    }),
    event("response.function_call_arguments.delta", { delta: "{" }),
    event("response.future_event"),
    event("response.completed", {
      response: { status: "incomplete", output: [] },
    }),
    event("response.completed", {
      response: {
        status: "completed",
        output: [],
        error: { code: "server_error" },
      },
    }),
    event("response.completed", {
      response: { status: "completed", output: null },
    }),
    'data: {"choices":[]}\n\n',
    "data: malformed\n\n",
    "data: [DONE]\n\n",
    empty +
      event("response.in_progress", {
        response: { status: "in_progress", output: [] },
      }),
  ])(
    "does not retry errors, tools or uncertain Responses streams (%#)",
    async (prefix) => {
      const body = prefix + empty;
      const request = vi.fn(async () => stream(body));
      expect(
        await (await fetchOpenCodeModelResponse(request, signal())).text(),
      ).toBe(body);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry a truncated stream, trailing garbage, or oversized prefix", async () => {
    for (const body of [
      reasoning,
      empty + "data: unfinished",
      text("x".repeat(1024 * 1024)) + empty,
    ]) {
      const request = vi.fn(async () => stream(body));
      expect(
        await (await fetchOpenCodeModelResponse(request, signal())).text(),
      ).toBe(body);
      expect(request).toHaveBeenCalledTimes(1);
    }
    const body = Buffer.concat([Buffer.from(empty), Buffer.from([0xc3])]);
    const request = vi.fn(async () => stream(body));
    expect(
      Buffer.from(
        await (
          await fetchOpenCodeModelResponse(request, signal())
        ).arrayBuffer(),
      ),
    ).toEqual(body);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recognizes a clean completion with byte-split UTF-8 and CRLF framing", async () => {
    const body = Buffer.from(
      (
        event("response.reasoning_summary_text.delta", { delta: "café" }) +
        completed()
      ).replace(/\n/g, "\r\n"),
    );
    const request = vi
      .fn()
      .mockImplementationOnce(async () =>
        stream(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < body.length; i++)
                controller.enqueue(body.subarray(i, i + 1));
              controller.close();
            },
          }),
        ),
      )
      .mockImplementationOnce(async () => stream(text("Done") + completed()));
    expect(
      await (await fetchOpenCodeModelResponse(request, signal())).text(),
    ).toContain("Done");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("leaves non-stream and HTTP error handling to the credential bridge", async () => {
    for (const response of [
      new Response("{}"),
      new Response("error", { status: 429 }),
    ]) {
      const request = vi.fn(async () => response);
      expect(await fetchOpenCodeModelResponse(request, signal())).toBe(
        response,
      );
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
