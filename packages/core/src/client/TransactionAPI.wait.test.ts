import { HttpClient } from "./HttpClient";
import { TransactionAPI } from "./TransactionAPI";

const client = (timeout = 30000) =>
  new HttpClient({
    baseURL: "https://api.example",
    timeout,
    headers: {},
  });

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it("preserves larger client budgets and leaves ordinary reads on the client default", async () => {
  const http = client(60000);
  const request = jest.spyOn(http, "request").mockResolvedValue({});
  const api = new TransactionAPI(http);
  await api.get("id", { since: "revision", maxWaitSeconds: 25 });
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: { since: "revision", maxWaitSeconds: 25 },
      timeoutMs: 60000,
    }),
  );
  await api.get("id");
  expect(request.mock.calls.at(-1)![0]).not.toHaveProperty("timeoutMs");
});

it.each([0, 1, 25])(
  "accepts a bounded wait of %s seconds",
  async (maxWaitSeconds) => {
    const http = client();
    const request = jest.spyOn(http, "request").mockResolvedValue({});
    await new TransactionAPI(http).get("id", { maxWaitSeconds });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ params: { maxWaitSeconds } }),
    );
  },
);

it.each([NaN, Infinity, -Infinity, -1, -0.5, 0.5, 25.5, 26, 60])(
  "refuses an invalid wait of %s before sending a request",
  async (maxWaitSeconds) => {
    const http = client();
    const request = jest.spyOn(http, "request").mockResolvedValue({});
    await expect(
      new TransactionAPI(http).get("id", { maxWaitSeconds }),
    ).rejects.toThrow("maxWaitSeconds must be a whole number from 0 to 25");
    expect(request).not.toHaveBeenCalled();
  },
);

it("applies a bounded wait's timeout override through the real fetch path", async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  const fetch = jest
    .spyOn(global, "fetch")
    .mockImplementation((_url, options) => {
      signal = options?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
  const pending = new TransactionAPI(client(10000)).get("id", {
    since: "revision",
    maxWaitSeconds: 25,
  });
  const rejected = expect(pending).rejects.toThrow(
    "Request timeout after 30000ms",
  );
  await jest.advanceTimersByTimeAsync(10001);
  expect(signal?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(19998);
  expect(signal?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(2);
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  [200, "application/json"],
  [503, "application/json"],
  [200, "text/plain"],
  [200, null],
] as const)(
  "bounds stalled %s %s bodies after headers arrive without retrying",
  async (status, contentType) => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = jest
      .spyOn(global, "fetch")
      .mockImplementation(async (_url, options) => {
        signal = options?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"pending":'));
            signal!.addEventListener("abort", () =>
              controller.error(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          },
        });
        return new Response(body, {
          status,
          headers: contentType ? { "content-type": contentType } : {},
        });
      });
    const pending = client(100).request({ url: "/read" });
    const rejected = expect(pending).rejects.toThrow(
      "Request timeout after 100ms",
    );
    await jest.advanceTimersByTimeAsync(101);
    expect(signal?.aborted).toBe(true);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("clears the deadline after the complete response body is read", async () => {
  jest.useFakeTimers();
  jest.spyOn(global, "fetch").mockResolvedValue(
    new Response('{"read":true}', {
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(client(100).request({ url: "/read" })).resolves.toEqual({
    read: true,
  });
  expect(jest.getTimerCount()).toBe(0);
});
