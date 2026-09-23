import { Transport } from "./index.js";
import { createClient } from "../client.js";
import { capabilityCall } from "./capability-call.js";
import * as eligibility from "./execution-delivery.js";
import { ExecutionIndeterminateError } from "../executions/errors.js";
import { SearchHttpError } from "../search/index.js";

const receipt = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  capabilityId: "web.scrape",
  status: "queued",
  createdAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-22T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const options = {
  errorPrefix: "Failed",
  makeError: (m: string, s: number, b: unknown) => new SearchHttpError(m, s, b),
};
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("controlled execution delivery", () => {
  it("keeps an unadopted capability inline even with an opted-in client", async () => {
    const calls: string[] = [];
    const transport = new Transport({
      apiKey: "k",
      coreBaseUrl: "https://core.test",
      capabilityDelivery: "executions",
      fetch: async (url) => {
        calls.push(String(url));
        return json({ markdown: "legacy" });
      },
    });
    expect(eligibility.executionDeliveryEligible("decisions.evaluate")).toBe(
      false,
    );
    expect(
      await capabilityCall("decisions.evaluate", {}, { ...options, transport }),
    ).toEqual({ markdown: "legacy" });
    expect(calls).toEqual([
      "https://core.test/v1/capabilities/decisions.evaluate",
    ]);
  });
  it("keeps legacy mode when fixture eligibility is enabled", async () => {
    jest.spyOn(eligibility, "executionDeliveryEligible").mockReturnValue(true);
    const fetch = jest.fn(async () => json({ markdown: "old" }));
    const client = createClient({
      apiKey: "k",
      coreBaseUrl: "https://core.test",
      fetch,
    });
    expect(
      (await client.search.scrape({ url: "https://example.test" })).markdown,
    ).toBe("old");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("returns raw outcomes through the existing namespace mapper and attributed configuration", async () => {
    jest.spyOn(eligibility, "executionDeliveryEligible").mockReturnValue(true);
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createClient({
      apiKey: "k",
      coreBaseUrl: "https://core.test",
      capabilityDelivery: "executions",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return json(
          init?.method === "POST"
            ? receipt
            : {
                ...receipt,
                status: "succeeded",
                result: { markdown: "stored", metadata: { title: "Page" } },
              },
        );
      },
    }).withAttribution({ agentName: "worker" });
    const result = await client.search.scrape({ url: "https://example.test" });
    expect(result.markdown).toBe("stored");
    expect(calls.map((c) => c.url)).toEqual([
      "https://core.test/v1/capabilities/web.scrape/executions",
      `https://core.test/v1/capability-executions/${receipt.id}`,
    ]);
    expect(
      calls.every(
        (c) =>
          new Headers(c.init.headers).get("x-sapiom-agent-name") === "worker",
      ),
    ).toBe(true);
  });
  it("snapshots delivery mode, base and key before a failed submit attempt", async () => {
    jest.useFakeTimers();
    const eligible = jest
      .spyOn(eligibility, "executionDeliveryEligible")
      .mockReturnValue(true);
    const savedBase = process.env.SAPIOM_BASE_URL;
    process.env.SAPIOM_BASE_URL = "https://original.test";
    const urls: string[] = [],
      keys: (string | null)[] = [];
    let n = 0;
    const transport = new Transport({
      apiKey: "k",
      capabilityDelivery: "executions",
      fetch: async (url, init) => {
        urls.push(String(url));
        keys.push(new Headers(init?.headers).get("Idempotency-Key"));
        if (++n === 1) {
          eligible.mockReturnValue(false);
          process.env.SAPIOM_BASE_URL = "https://changed.test";
          throw new Error("lost receipt");
        }
        return json(
          init?.method === "POST"
            ? receipt
            : { ...receipt, status: "succeeded", result: "saved" },
        );
      },
    });
    try {
      const pending = capabilityCall(
        "web.scrape",
        {},
        { ...options, transport },
      );
      await jest.advanceTimersByTimeAsync(500);
      expect(await pending).toBe("saved");
      expect(
        urls.every((url) => url.startsWith("https://original.test/")),
      ).toBe(true);
      expect(keys[0]).toBe(keys[1]);
      expect(eligible).toHaveBeenCalledTimes(1);
    } finally {
      if (savedBase === undefined) delete process.env.SAPIOM_BASE_URL;
      else process.env.SAPIOM_BASE_URL = savedBase;
    }
  });
  it.each([404, 503])(
    "rejects unsupported/admission-off HTTP %i without a synchronous fallback",
    async (status) => {
      jest
        .spyOn(eligibility, "executionDeliveryEligible")
        .mockReturnValue(true);
      const fetch = jest.fn(async () =>
        json({ code: "admission_disabled" }, status),
      );
      const client = createClient({
        apiKey: "k",
        coreBaseUrl: "https://core.test",
        capabilityDelivery: "executions",
        fetch,
      });
      await expect(
        client.search.scrape({ url: "https://example.test" }),
      ).rejects.toMatchObject({
        status,
        body: { code: "admission_disabled" },
        submissionKey: expect.any(String),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["failed", "indeterminate"])(
    "preserves the %s error contract",
    async (status) => {
      jest
        .spyOn(eligibility, "executionDeliveryEligible")
        .mockReturnValue(true);
      const client = createClient({
        apiKey: "k",
        coreBaseUrl: "https://core.test",
        capabilityDelivery: "executions",
        fetch: async (_, init) =>
          json(
            init?.method === "POST"
              ? receipt
              : {
                  ...receipt,
                  status,
                  error: {
                    code: `execution_${status}`,
                    message: "Safe failure",
                  },
                },
          ),
      });
      await expect(
        client.search.scrape({ url: "https://example.test" }),
      ).rejects.toBeInstanceOf(
        status === "failed" ? SearchHttpError : ExecutionIndeterminateError,
      );
    },
  );
  it("preserves native media launch handles and workflow resume headers", async () => {
    jest.spyOn(eligibility, "executionDeliveryEligible").mockReturnValue(true);
    const imageReceipt = {
      ...receipt,
      capabilityId: "content.generation.images",
    };
    const calls: RequestInit[] = [];
    const client = createClient({
      apiKey: "k",
      coreBaseUrl: "https://core.test",
      capabilityDelivery: "executions",
      resumeToken: "fixture-resume",
      fetch: async (_, init) => {
        calls.push(init!);
        return json(
          init?.method === "POST"
            ? imageReceipt
            : {
                ...imageReceipt,
                status: "succeeded",
                result: {
                  requestId: "native-id",
                  responseUrl: "https://generation.test/result",
                  resolvedModel: "fixture-model",
                },
              },
        );
      },
    });
    const native = await client.contentGeneration.images.launch({
      prompt: "fixture",
    });
    expect(native.requestId).toBe("native-id");
    expect(typeof native.wait).toBe("function");
    expect(new Headers(calls[0].headers).get("x-sapiom-workflow-token")).toBe(
      "fixture-resume",
    );
    expect(calls).toHaveLength(2);
  });
});
