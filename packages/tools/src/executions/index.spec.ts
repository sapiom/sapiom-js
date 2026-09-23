import { createClient } from "../client.js";
import { createStubClient } from "../stub/index.js";
import {
  ExecutionHttpError,
  ExecutionInterruptedError,
  ExecutionProtocolError,
  ExecutionTransportError,
} from "./errors.js";

const receipt = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  capabilityId: "fixture.echo",
  status: "queued",
  createdAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-22T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup(impl: typeof globalThis.fetch = async () => json(receipt, 202)) {
  const fetch = jest.fn(impl);
  const client = createClient({
    apiKey: "fixture-key",
    fetch,
    coreBaseUrl: "https://core.test/",
  });
  return {
    client,
    fetch,
    submission: client.executions.prepare(
      "fixture.echo",
      { input: { value: 1 } },
      { submissionKey: "persisted-key" },
    ),
  };
}
afterEach(() => jest.useRealTimers());

describe("execution prepare/submit/get", () => {
  it("keeps stub clients offline and clearly rejects durable submission", async () => {
    const stub = createStubClient();
    await expect(
      stub.executions.submit(stub.executions.prepare("fixture.echo", {})),
    ).rejects.toThrow("unavailable in stub mode");
  });
  it("binds clients/attribution, snapshots JSON and retrieves terminal receipts separately", async () => {
    const calls: RequestInit[] = [];
    const client = createClient({
      apiKey: "k",
      coreBaseUrl: "https://core.test",
      fetch: async (url, init) => {
        expect(String(url)).toMatch(/^https:\/\/core.test\/v1\//);
        calls.push(init!);
        return json(
          {
            ...receipt,
            status: "succeeded",
            ...(init?.method === "GET" ? { result: null } : {}),
          },
          init?.method === "GET" ? 200 : 202,
        );
      },
    }).withAttribution({ agentName: "fixture", executionId: "run-1" });
    const input = { nested: { n: 1 } };
    const saved = client.executions.prepare("fixture.echo", input);
    input.nested.n = 2;
    expect(saved.request).toEqual({ nested: { n: 1 } });
    expect(Object.isFrozen(saved.request.nested)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('"apiKey"');
    const handle = await client.executions.submit(
      JSON.parse(JSON.stringify(saved)),
    );
    expect(handle.receipt.status).toBe("succeeded");
    expect(handle.receipt).not.toHaveProperty("result");
    expect(await client.executions.get(handle.receipt.id)).toMatchObject({
      status: "succeeded",
      result: null,
    });
    expect(new Headers(calls[0].headers).get("x-api-key")).toBe("k");
    expect(new Headers(calls[0].headers).get("x-sapiom-agent-name")).toBe(
      "fixture",
    );
    expect(new Headers(calls[0].headers).get("x-sapiom-execution-id")).toBe(
      "run-1",
    );
    expect(new Headers(calls[0].headers).get("Idempotency-Key")).toBe(
      saved.submissionKey,
    );
  });
  it("retries a lost receipt with exactly the same key/body and never switches endpoint", async () => {
    jest.useFakeTimers();
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createClient({
      apiKey: "k",
      coreBaseUrl: "https://core.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        if (calls.length < 3)
          throw new Error("untrusted credential-bearing network detail");
        return json(receipt);
      },
    });
    const saved = client.executions.prepare("fixture.echo", { n: 1 });
    const pending = client.executions.submit(saved);
    await jest.advanceTimersByTimeAsync(1000);
    expect((await pending).receipt.id).toBe(receipt.id);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.url))).toEqual(
      new Set(["https://core.test/v1/capabilities/fixture.echo/executions"]),
    );
    expect(new Set(calls.map((c) => c.init.body))).toEqual(
      new Set(['{"n":1}']),
    );
    expect(
      calls.every(
        (c) =>
          new Headers(c.init.headers).get("Idempotency-Key") ===
            saved.submissionKey && c.init.redirect === "error",
      ),
    ).toBe(true);
  });
  it.each([400, 401, 403, 404, 409, 410, 413, 422])(
    "stops on HTTP %i and preserves resumption metadata",
    async (status) => {
      const { client, fetch, submission } = setup(async () =>
        json({ code: "rejected", secret: "not copied" }, status),
      );
      await expect(client.executions.submit(submission)).rejects.toMatchObject({
        status,
        submissionKey: submission.submissionKey,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("stops on admission-disabled 503 and unsupported/protocol errors", async () => {
    const { client, fetch, submission } = setup(async () =>
      json({ code: "admission_disabled" }, 503),
    );
    await expect(client.executions.submit(submission)).rejects.toBeInstanceOf(
      ExecutionHttpError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => json({ ...receipt, version: 2 }));
    await expect(client.executions.submit(submission)).rejects.toMatchObject({
      name: "ExecutionProtocolError",
      submissionKey: "persisted-key",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not send credentials to a changed saved origin or receipt URL", async () => {
    const { client, fetch, submission } = setup(
      async () =>
        new Response(JSON.stringify({ ...receipt, url: "https://evil.test" }), {
          status: 202,
          headers: { Location: "https://evil.test" },
        }),
    );
    await expect(
      client.executions.submit({
        ...submission,
        coreBaseUrl: "https://evil.test",
      }),
    ).rejects.toBeInstanceOf(ExecutionProtocolError);
    expect(fetch).not.toHaveBeenCalled();
    await client.executions.submit(submission);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://core.test/v1/capabilities/fixture.echo/executions",
    );
  });
  it("bounds a fetch or response body that ignores AbortSignal and preserves the key", async () => {
    jest.useFakeTimers();
    const { client, fetch, submission } = setup(
      async () => new Promise<Response>(() => {}),
    );
    const pending = client.executions.submit(submission);
    const rejection = expect(pending).rejects.toMatchObject({
      name: "ExecutionInterruptedError",
      submissionKey: "persisted-key",
    });
    await jest.advanceTimersByTimeAsync(30_001);
    await rejection;
    expect(fetch).toHaveBeenCalledTimes(2);
    const body = setup(
      async () =>
        ({
          status: 200,
          ok: true,
          text: () => new Promise<string>(() => {}),
        }) as Response,
    );
    const request = expect(
      body.client.executions.get(receipt.id, { requestTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(ExecutionTransportError);
    await jest.advanceTimersByTimeAsync(11);
    await request;
  });
  it("honors caller abort before acceptance or during a request without leaking raw errors", async () => {
    const { client, fetch, submission } = setup(
      async () => new Promise<Response>(() => {}),
    );
    const controller = new AbortController();
    const request = expect(
      client.executions.submit(submission, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ExecutionInterruptedError);
    controller.abort();
    await request;
    await expect(
      client.executions.submit(submission, { signal: controller.signal }),
    ).rejects.toMatchObject({ submissionKey: "persisted-key" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid IDs, mismatched responses and unsafe base URLs before a request", async () => {
    const { client, fetch } = setup(async () =>
      json({ ...receipt, id: "22222222-2222-4222-8222-222222222222" }),
    );
    await expect(client.executions.get("../secret")).rejects.toBeInstanceOf(
      ExecutionProtocolError,
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.executions.get(receipt.id)).rejects.toMatchObject({
      executionId: receipt.id,
    });
    expect(() =>
      client.executions.prepare(
        "fixture.echo",
        {},
        { baseUrl: "https://core.test/?secret=yes" },
      ),
    ).toThrow();
  });
});
