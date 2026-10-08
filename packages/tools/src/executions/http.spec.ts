import { Transport } from "../_client/index.js";
import { executionRequest } from "./http.js";
import {
  ExecutionExpiredError,
  ExecutionHttpError,
  ExecutionInterruptedError,
  ExecutionProtocolError,
  ExecutionTransportError,
} from "./errors.js";

const reference = { submissionKey: "saved-key" };
const make = (fetch: typeof globalThis.fetch) =>
  new Transport({ apiKey: "credential", fetch });
afterEach(() => jest.useRealTimers());
describe("bounded execution HTTP", () => {
  it("bounds response-body reading and aborts the underlying request", async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const transport = make(async (_, init) => {
      signal = init?.signal;
      return {
        status: 200,
        ok: true,
        text: () => new Promise<string>(() => {}),
      } as Response;
    });
    const pending = expect(
      executionRequest(
        transport,
        "https://core.test/job",
        { method: "GET" },
        { requestTimeoutMs: 10 },
        reference,
      ),
    ).rejects.toBeInstanceOf(ExecutionTransportError);
    await jest.advanceTimersByTimeAsync(10);
    await pending;
    expect(signal?.aborted).toBe(true);
  });
  it("does not dispatch an already-aborted request", async () => {
    const fetch = jest.fn(async () => new Response("{}"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      executionRequest(
        make(fetch),
        "https://core.test/job",
        {},
        { signal: controller.signal },
        reference,
      ),
    ).rejects.toBeInstanceOf(ExecutionInterruptedError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects followed redirects and malformed success without exposing the raw body", async () => {
    const redirect = new Response("{}");
    Object.defineProperty(redirect, "redirected", { value: true });
    await expect(
      executionRequest(
        make(async () => redirect),
        "https://core.test/job",
        {},
        {},
        reference,
      ),
    ).rejects.toBeInstanceOf(ExecutionProtocolError);
    await expect(
      executionRequest(
        make(async () => new Response("private provider body")),
        "https://core.test/job",
        {},
        {},
        reference,
      ),
    ).rejects.toMatchObject({
      name: "ExecutionProtocolError",
      submissionKey: "saved-key",
      message: "Invalid execution JSON response.",
    });
  });
  it("retains safe HTTP fields, separates expiry, and parses Retry-After", async () => {
    const transport = make(
      async () =>
        new Response(
          JSON.stringify({
            code: "rate_limited",
            message: "Try later",
            private: "secret",
          }),
          { status: 429, headers: { "Retry-After": "2" } },
        ),
    );
    await expect(
      executionRequest(transport, "https://core.test/job", {}, {}, reference),
    ).rejects.toMatchObject({
      status: 429,
      body: { code: "rate_limited", message: "Try later" },
      retryAfterMs: 2000,
    });
    await expect(
      executionRequest(
        make(async () => new Response("", { status: 410 })),
        "https://core.test/job",
        {},
        {},
        reference,
      ),
    ).rejects.toBeInstanceOf(ExecutionExpiredError);
    await expect(
      executionRequest(
        make(
          async () => new Response("private provider body", { status: 503 }),
        ),
        "https://core.test/job",
        {},
        {},
        reference,
      ),
    ).rejects.toBeInstanceOf(ExecutionHttpError);
  });
  it("replaces raw fetch errors with safe metadata and validates timeout overrides", async () => {
    const transport = make(async () => {
      throw new Error("credential private payload");
    });
    await expect(
      executionRequest(transport, "https://core.test/job", {}, {}, reference),
    ).rejects.toMatchObject({
      name: "ExecutionTransportError",
      submissionKey: "saved-key",
      message: "Execution request failed; acceptance may be unknown.",
    });
    await expect(
      executionRequest(
        transport,
        "https://core.test/job",
        {},
        { requestTimeoutMs: NaN },
        reference,
      ),
    ).rejects.toBeInstanceOf(ExecutionProtocolError);
  });
});
