/**
 * Cross-package proof: the facts `@sapiom/tools` records and the rule
 * `@sapiom/agent` applies agree, and the in-process runtime composes them the
 * same way the sandbox step-runner does.
 *
 * Neither package imports the other's half, so nothing but a test that runs a
 * real capability call through a real serializer catches a drift between them.
 */
import { runInNewContext } from "node:vm";

import { SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT } from "@sapiom/agent";
import { serializeStepCompletionError } from "@sapiom/agent-runtime";
import { createClient, readSapiomCall, SearchHttpError } from "@sapiom/tools";

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
