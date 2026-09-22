/**
 * Cross-package proof: the facts `@sapiom/tools` records and the rule
 * `@sapiom/agent` applies agree, and the in-process runtime composes them the
 * same way the sandbox step-runner does.
 *
 * Neither package imports the other's half, so nothing but a test that runs a
 * real capability call through a real serializer catches a drift between them.
 */
import { runInNewContext } from "node:vm";

import {
  SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT,
  agentManifestSchema,
  buildManifest,
  defineAgent,
  defineStep,
} from "@sapiom/agent";
import type { AgentManifest } from "@sapiom/agent";
import { serializeStepCompletionError } from "@sapiom/agent-runtime";
import { createClient, readSapiomCall, SearchHttpError } from "@sapiom/tools";

import { AgentRunnerCore, InMemoryExecutionStore } from "@sapiom/agent-runtime";

import { LocalStubDispatcher } from "./dispatcher.js";

function clientAnswering(response: () => Response) {
  return createClient({
    apiKey: "test-key",
    fetch: (async () => response()) as typeof globalThis.fetch,
  });
}

const caught = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(() => null).catch((e: unknown) => e);

describe("a ctx.sapiom.* call that fails", () => {
  it("serializes a transient failure as the canonical retryable payload", async () => {
    const sapiom = clientAnswering(
      () =>
        new Response(JSON.stringify({ error: "upstream unavailable" }), {
          status: 503,
          headers: { "Retry-After": "2" },
        }),
    );

    const error = await caught(sapiom.search.webSearch({ query: "anything" }));

    // The author's own `catch (e) { if (e instanceof SearchHttpError) ... }`
    // still works: nothing was wrapped.
    expect(error).toBeInstanceOf(SearchHttpError);
    expect(serializeStepCompletionError(error, readSapiomCall(error))).toEqual({
      name: "SearchHttpError",
      message: (error as Error).message,
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
      retryable: true,
      status: 503,
      capability: "web.search",
      retryAfterMs: 2000,
      stack: (error as Error).stack,
    });
  });

  it("leaves a deterministic failure on the legacy shape", async () => {
    const sapiom = clientAnswering(
      () => new Response("no such thing", { status: 404 }),
    );

    const error = await caught(sapiom.search.webSearch({ query: "anything" }));
    const payload = serializeStepCompletionError(error, readSapiomCall(error));

    expect(error).toBeInstanceOf(SearchHttpError);
    expect(payload).toEqual({
      name: "SearchHttpError",
      message: (error as Error).message,
      stack: (error as Error).stack,
    });
    expect(payload).not.toHaveProperty("retryable");
  });

  it("serializes a connection that never happened as retryable, with no status", async () => {
    const sapiom = createClient({
      apiKey: "test-key",
      fetch: (() => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      }) as typeof globalThis.fetch,
    });

    const error = await caught(sapiom.search.webSearch({ query: "anything" }));
    const payload = serializeStepCompletionError(error, readSapiomCall(error));

    expect(payload).toMatchObject({
      name: "TypeError",
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      retryable: true,
      capability: "web.search",
    });
    expect(payload).not.toHaveProperty("status");
  });

  it("reads the facts off the thrown value, not a replacement", async () => {
    // A cross-realm error fails `instanceof Error`, so any host that normalizes
    // with `err instanceof Error ? err : new Error(String(err))` must still read
    // the marker off the original value. The replacement carries nothing.
    const thrown = runInNewContext(
      'Object.assign(new Error("Failed to search: 503"), { name: "SearchHttpError", sapiomCall: { version: 1, capability: "web.search", status: 503 } })',
    ) as Error;
    expect(thrown).not.toBeInstanceOf(Error);

    const normalized =
      thrown instanceof Error ? thrown : new Error(String(thrown));

    expect(readSapiomCall(normalized)).toBeUndefined();
    expect(
      serializeStepCompletionError(normalized, readSapiomCall(thrown)),
    ).toMatchObject({
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      retryable: true,
      status: 503,
      capability: "web.search",
    });
  });

  it("leaves an error the author threw themselves untouched", async () => {
    const authorError = new Error("the data was not what I expected");

    expect(
      serializeStepCompletionError(authorError, readSapiomCall(authorError)),
    ).toEqual({
      name: "Error",
      message: authorError.message,
      stack: authorError.stack,
    });
  });
});

describe("run_local parity, end to end", () => {
  /**
   * The serializer keeping the fields is only half of it: the in-process runner
   * then rehydrates the payload before the store records it. That path used to
   * go through the legacy branch, which keeps only name/message/stack, so a
   * local run recorded strictly less than a deployed one and the parity this
   * file claims was not actually held.
   *
   * Asserted on what reaches `failStep`, because the execution row itself ends
   * up carrying the cap error: attaching the cause there is the engine half of
   * SAP-3509.
   */
  it("keeps the transient fields on the recorded step failure", async () => {
    const entry = defineStep({
      name: "entry",
      next: [],
      terminal: true,
      async run() {
        throw Object.assign(new Error("Failed to search: 503 upstream down"), {
          name: "SearchHttpError",
          status: 503,
          sapiomCall: {
            version: 1,
            capability: "web.search",
            status: 503,
            retryAfterMs: 2000,
          },
        });
      },
    });
    const definition = defineAgent({
      name: "transient-local",
      entry: "entry",
      steps: { entry },
    });
    const manifest = agentManifestSchema.parse(
      buildManifest(definition, {
        sdkVersion: "0.0.0-test",
        artifact: { sha256: "x", entryFile: "def.mjs" },
      }),
    ) as AgentManifest;

    const store = new InMemoryExecutionStore();
    const recorded: unknown[] = [];
    const failStep = store.failStep.bind(store);
    store.failStep = async (args) => {
      recorded.push(args.error);
      return failStep(args);
    };
    const dispatcher = new LocalStubDispatcher(definition, {
      version: 1,
      steps: {},
    });
    const core = new AgentRunnerCore({ store, dispatcher });
    dispatcher.setCore(core);
    dispatcher.setMaxAttempts(1);

    const executionId = await core.createExecution(
      definition.name,
      definition.entry,
      {},
      { manifest },
    );
    await core.advance(executionId);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      name: "SearchHttpError",
      message: "Failed to search: 503 upstream down",
      code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
      retryable: true,
      status: 503,
      capability: "web.search",
      retryAfterMs: 2000,
    });
    expect(recorded[0]).toBeInstanceOf(Error);
  });
});
