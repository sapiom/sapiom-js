import { createClient } from "../client.js";
import {
  ExecutionExpiredError,
  ExecutionFailedError,
  ExecutionHttpError,
  ExecutionIndeterminateError,
  ExecutionProtocolError,
  ExecutionWaitInterruptedError,
} from "./errors.js";
const receipt = {
  version: 1 as const,
  id: "11111111-1111-4111-8111-111111111111",
  capabilityId: "fixture.echo",
  status: "queued" as const,
  createdAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-22T00:00:00.000Z",
};
const handle = {
  receipt,
  submissionKey: "saved-key",
  coreBaseUrl: "https://core.test",
};
const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });
function setup(impl: typeof fetch) {
  const fetch = jest.fn(impl);
  return {
    client: createClient({
      apiKey: "fixture",
      coreBaseUrl: handle.coreBaseUrl,
      fetch,
    }),
    fetch,
  };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("execution wait and resumption", () => {
  it("backs off pending GETs and resumes a serialized handle on a fresh client without POST", async () => {
    let n = 0;
    const { client, fetch } = setup(async () =>
      json(
        ++n < 4
          ? receipt
          : { ...receipt, status: "succeeded", result: { answer: 42 } },
      ),
    );
    const pending = client.executions.wait(handle);
    await jest.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ answer: 42 });
    const fresh = setup(async () =>
      json({ ...receipt, status: "succeeded", result: { answer: 42 } }),
    );
    expect(
      await fresh.client.executions.wait(JSON.parse(JSON.stringify(handle))),
    ).toEqual({ answer: 42 });
    expect(
      [...fetch.mock.calls, ...fresh.fetch.mock.calls].every(
        ([, init]) => init?.method === "GET",
      ),
    ).toBe(true);
  });
  it("retries transient network/HTTP errors, honors Retry-After and stops at the wait budget", async () => {
    const { client, fetch } = setup(async () =>
      json({}, 429, { "Retry-After": "999" }),
    );
    const pending = expect(
      client.executions.wait(handle, { waitTimeoutMs: 2000 }),
    ).rejects.toMatchObject({
      name: "ExecutionWaitInterruptedError",
      executionId: receipt.id,
      submissionKey: handle.submissionKey,
    });
    await jest.advanceTimersByTimeAsync(2000);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    let n = 0;
    const temporary = setup(async () => {
      n++;
      if (n === 1) throw new Error("network");
      if (n < 5) return json({}, [502, 503, 504][n - 2]);
      return json({ ...receipt, status: "succeeded", result: null });
    });
    const recovered = temporary.client.executions.wait(receipt.id);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(await recovered).toBeNull();
    expect(temporary.fetch).toHaveBeenCalledTimes(5);
  });
  it.each([401, 403, 404, 409, 410])(
    "stops on non-retryable HTTP %i",
    async (status) => {
      const { client, fetch } = setup(async () => json({}, status));
      await expect(client.executions.wait(handle)).rejects.toBeInstanceOf(
        status === 410 ? ExecutionExpiredError : ExecutionHttpError,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["failed", "indeterminate"])(
    "surfaces the distinct %s outcome on HTTP 200",
    async (status) => {
      const error = { code: `execution_${status}`, message: "Safe failure" };
      const { client, fetch } = setup(async () =>
        json({ ...receipt, status, error }),
      );
      await expect(client.executions.wait(handle)).rejects.toBeInstanceOf(
        status === "failed"
          ? ExecutionFailedError
          : ExecutionIndeterminateError,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([false, true])(
    "bounds cancellation during fetch or sleep (sleep=%s)",
    async (sleep) => {
      const { client, fetch } = setup(async () =>
        sleep ? json(receipt) : new Promise<Response>(() => {}),
      );
      const controller = new AbortController();
      const pending = expect(
        client.executions.wait(handle, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(ExecutionWaitInterruptedError);
      await jest.advanceTimersByTimeAsync(1);
      controller.abort();
      await pending;
      await jest.advanceTimersByTimeAsync(20_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(!sleep);
    },
  );
  it("caps an in-flight request to remaining wait time, even if fetch ignores abort", async () => {
    const { client, fetch } = setup(
      async () => new Promise<Response>(() => {}),
    );
    const pending = expect(
      client.executions.wait(handle, { waitTimeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ExecutionWaitInterruptedError);
    await jest.advanceTimersByTimeAsync(20);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("rejects saved-origin/capability mismatch and validates finite overrides", async () => {
    const { client, fetch } = setup(async () =>
      json({ ...receipt, capabilityId: "other.capability" }),
    );
    await expect(
      client.executions.wait({ ...handle, coreBaseUrl: "https://evil.test" }),
    ).rejects.toBeInstanceOf(ExecutionProtocolError);
    for (const waitTimeoutMs of [0, -1, NaN, Infinity])
      await expect(
        client.executions.wait(handle, { waitTimeoutMs }),
      ).rejects.toBeInstanceOf(ExecutionProtocolError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.executions.wait(handle)).rejects.toBeInstanceOf(
      ExecutionProtocolError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
