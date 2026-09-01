import * as sapiomTools from "@sapiom/tools";
import { MockSemanticGraphProvider } from "../providers/mock.js";
import {
  SapiomLunaProvider,
  assertRealEvaluationEnabled,
} from "../providers/sapiom-luna.js";
import { validateProviderAttempt } from "../validation.js";
import { corpus, fixtureById, requestFor } from "./test-helpers.js";

describe("provider boundary", () => {
  it("replays one raw mock response and counts the immutable run identity", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "opaque-store-reload");
    const request = requestFor(fixture);
    const provider = new MockSemanticGraphProvider(fixtures);
    const attempt = await provider.invoke(request);
    expect(attempt.status).toBe("success");
    if (attempt.status !== "success") throw new Error("Expected mock success");
    expect(attempt.rawResponse).toEqual(
      fixture.providerFixture.responses["bounded-source.v1"].status ===
        "success"
        ? fixture.providerFixture.responses["bounded-source.v1"].rawResponse
        : undefined,
    );
    expect(provider.invocationCount(request)).toBe(1);
    expect(provider.totalInvocationCount).toBe(1);
    expect(attempt.requestedModel).toBe("gpt-luna");
  });

  it("makes one Sapiom gpt-luna call with fallback disabled and forced output", async () => {
    const fixture = fixtureById(await corpus(), "complete-abstention");
    const request = requestFor(fixture);
    const calls: Array<{
      input: Parameters<typeof globalThis.fetch>[0];
      init?: RequestInit;
    }> = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "propose_semantic_feeds",
              input: { outcome: "abstained", candidates: [] },
            },
          ],
          usage: { input_tokens: 321, output_tokens: 12 },
          served_class: "medium",
          lane: "run_now",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    let clock = 100;
    const provider = new SapiomLunaProvider({
      environment: {
        RUN_REAL_SEMANTIC_GRAPH_EVAL: "1",
        SAPIOM_API_KEY: "test-only-key",
      },
      fetch: fetchImpl,
      now: () => {
        const value = clock;
        clock += 25;
        return value;
      },
    });
    const attempt = await provider.invoke(request);
    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-sapiom-model"]).toBe("gpt-luna");
    expect(headers["x-sapiom-never-fail"]).toBe("false");
    expect(headers["x-sapiom-api-key"]).toBe("test-only-key");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, any>;
    expect(body.max_tokens).toBe(request.configuration.maxOutputTokens);
    expect(body.tools).toEqual([
      {
        name: "propose_semantic_feeds",
        input_schema: request.prompt.outputSchema,
      },
    ]);
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "propose_semantic_feeds",
    });
    expect(attempt).toEqual({
      status: "success",
      rawResponse: { outcome: "abstained", candidates: [] },
      usage: {
        inputTokens: 321,
        outputTokens: 12,
        costUsd: null,
        latencyMs: 25,
        servedClass: "medium",
        lane: "run_now",
      },
      requestedModel: "gpt-luna",
    });
  });

  it("routes a missing forced output through malformed validation", async () => {
    const fixture = fixtureById(await corpus(), "complete-abstention");
    const request = requestFor(fixture);
    const provider = new SapiomLunaProvider({
      environment: {
        RUN_REAL_SEMANTIC_GRAPH_EVAL: "1",
        SAPIOM_API_KEY: "test-only-key",
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "No forced tool payload" }],
            usage: { input_tokens: 10, output_tokens: 4 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      now: () => 10,
    });
    const attempt = await provider.invoke(request);
    expect(attempt.status).toBe("success");
    expect(validateProviderAttempt(request, attempt).attemptStatus).toBe(
      "malformed",
    );
  });

  it("records post-response harness faults without relabeling the provider", async () => {
    const fixture = fixtureById(await corpus(), "complete-abstention");
    const request = requestFor(fixture);
    const shutdown = jest.fn().mockResolvedValue(undefined);
    const createClient = jest
      .spyOn(sapiomTools, "createClient")
      .mockReturnValue({
        llm: {
          run: jest.fn().mockResolvedValue({}),
          structuredOf: () => {
            throw new Error("private client normalization detail");
          },
          readDisclosure: jest.fn(),
        },
        shutdown,
      } as unknown as ReturnType<typeof sapiomTools.createClient>);
    let clock = 100;
    const provider = new SapiomLunaProvider({
      environment: {
        RUN_REAL_SEMANTIC_GRAPH_EVAL: "1",
        SAPIOM_API_KEY: "test-only-key",
      },
      now: () => {
        const value = clock;
        clock += 25;
        return value;
      },
    });

    try {
      const attempt = await provider.invoke(request);
      expect(attempt).toEqual({
        status: "harness-failure",
        errorCode: "response-normalization-error",
        latencyMs: 25,
        requestedModel: "gpt-luna",
      });
      expect(JSON.stringify(attempt)).not.toContain("private client");
      expect(validateProviderAttempt(request, attempt)).toMatchObject({
        attemptStatus: "malformed",
        providerErrorCode: null,
        outcome: "failed",
        rejected: [{ code: "harness-failure" }],
      });
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      createClient.mockRestore();
    }
  });

  it("sanitizes provider failures without persisting the response body", async () => {
    const fixture = fixtureById(await corpus(), "complete-abstention");
    const provider = new SapiomLunaProvider({
      environment: {
        RUN_REAL_SEMANTIC_GRAPH_EVAL: "1",
        SAPIOM_API_KEY: "test-only-key",
      },
      fetch: async () =>
        new Response("private upstream diagnostics and credential material", {
          status: 429,
        }),
      now: () => 10,
    });
    const attempt = await provider.invoke(requestFor(fixture));
    expect(attempt).toEqual({
      status: "failure",
      errorCode: "http-429",
      latencyMs: 0,
      requestedModel: "gpt-luna",
    });
    expect(JSON.stringify(attempt)).not.toContain("private upstream");
  });

  it("requires both explicit authorization and a credential before networking", async () => {
    expect(() => assertRealEvaluationEnabled({})).toThrow(
      "RUN_REAL_SEMANTIC_GRAPH_EVAL=1",
    );
    expect(() =>
      assertRealEvaluationEnabled({ RUN_REAL_SEMANTIC_GRAPH_EVAL: "1" }),
    ).toThrow("SAPIOM_API_KEY is not set");
    let calls = 0;
    const fixture = fixtureById(await corpus(), "complete-abstention");
    const provider = new SapiomLunaProvider({
      environment: {},
      fetch: async () => {
        calls += 1;
        throw new Error("network should remain unreachable");
      },
    });
    await expect(provider.invoke(requestFor(fixture))).rejects.toThrow(
      "Luna evaluation is disabled",
    );
    expect(calls).toBe(0);
  });
});
