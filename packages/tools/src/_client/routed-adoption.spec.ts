import { createClient } from "../client.js";
import { webSearch } from "../search/index.js";
import { Transport } from "./index.js";
import { executionDeliveryEligible } from "./execution-delivery.js";

type Client = ReturnType<typeof createClient>;
const native = {
  requestId: "native",
  resolvedModel: "balanced",
  responseUrl: "https://generation.test/result",
};
const cases: {
  name: string;
  id: string;
  call: (client: Client) => Promise<unknown>;
  result: unknown;
  polls?: number;
}[] = [
  {
    name: "scrape",
    id: "web.scrape",
    call: (c) =>
      c.search.scrape({
        url: "https://page.test",
        formats: ["markdown", "rawHtml"],
      }),
    result: {
      markdown: "",
      rawHtml: "<p>page</p>",
      metadata: { title: "Page" },
    },
  },
  {
    name: "research",
    id: "web.search",
    call: (c) =>
      c.search.webSearch({
        query: "question",
        intent: "answer",
        depth: "deep",
      }),
    result: {
      query: "question",
      answer: "answer",
      results: [
        { title: "Page", url: "https://page.test", snippet: "evidence" },
      ],
    },
  },
  {
    name: "findEmail",
    id: "email.find",
    call: (c) =>
      c.search.emailSearch.findEmail({
        fullName: "Test Person",
        domain: "example.test",
      }),
    result: { email: null },
  },
  {
    name: "verifyEmail",
    id: "email.verify",
    call: (c) =>
      c.search.emailSearch.verifyEmail({ email: "test@example.test" }),
    result: { email: "test@example.test", smtpCheck: false, score: 0 },
  },
  {
    name: "domainSearch",
    id: "email.domain.search",
    call: (c) =>
      c.search.emailSearch.domainSearch({
        domain: "example.test",
        department: ["engineering"],
        seniority: ["senior"],
        limit: 3,
      }),
    result: { domain: "example.test", acceptAll: false, emails: [] },
  },
  {
    name: "images.create",
    id: "content.generation.images",
    call: (c) =>
      c.contentGeneration.images.create({
        prompt: "scene",
        idempotencyKey: "native-key",
      }),
    result: {
      images: [{ url: "https://image.test", content_type: "image/png" }],
      resolvedModel: "balanced",
    },
  },
  {
    name: "images.launch",
    id: "content.generation.images",
    call: (c) =>
      c.contentGeneration.images.launch({
        prompt: "scene",
        idempotencyKey: "native-key",
      }),
    result: native,
  },
  {
    name: "video.create",
    id: "content.generation.video",
    call: (c) =>
      c.contentGeneration.video.create({
        prompt: "scene",
        idempotencyKey: "native-key",
      }),
    result: native,
    polls: 1,
  },
  {
    name: "video.launch",
    id: "content.generation.video",
    call: (c) =>
      c.contentGeneration.video.launch({
        prompt: "scene",
        idempotencyKey: "native-key",
      }),
    result: native,
  },
];
const json = (value: unknown) => new Response(JSON.stringify(value));

describe("common-helper adoption", () => {
  it.each(cases)(
    "preserves $name requests, values and native ownership in both modes",
    async (fixture) => {
      const observations = [];
      for (const capabilityDelivery of ["legacy", "executions"] as const) {
        const calls: { url: string; init: RequestInit }[] = [];
        const receipt = {
          version: 1,
          id: "11111111-1111-4111-8111-111111111111",
          capabilityId: fixture.id,
          status: "queued",
          createdAt: "2026-09-23T00:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z",
        };
        const client = createClient({
          apiKey: "fixture",
          coreBaseUrl: "https://core.test",
          capabilityDelivery,
          resumeToken: "resume",
          fetch: async (url, init) => {
            calls.push({ url: String(url), init: init! });
            if (String(url) === native.responseUrl)
              return json({ video: { url: "https://video.test/result.mp4" } });
            if (String(url).endsWith("/executions")) return json(receipt);
            if (String(url).includes("/capability-executions/"))
              return json({
                ...receipt,
                status: "succeeded",
                result: fixture.result,
              });
            return json(fixture.result);
          },
        }).withAttribution({ agentName: "adoption" });
        const result = await fixture.call(client);
        const submit = calls[0];
        expect(submit.url).toBe(
          `https://core.test/v1/capabilities/${fixture.id}${capabilityDelivery === "executions" ? "/executions" : ""}`,
        );
        expect(new Headers(submit.init.headers).get("x-api-key")).toBe(
          "fixture",
        );
        expect(
          new Headers(submit.init.headers).get("x-sapiom-agent-name"),
        ).toBe("adoption");
        expect(calls).toHaveLength(
          (capabilityDelivery === "executions" ? 2 : 1) + (fixture.polls ?? 0),
        );
        if (fixture.name.endsWith("launch")) {
          expect(result).toMatchObject({
            requestId: "native",
            wait: expect.any(Function),
          });
          expect(
            new Headers(submit.init.headers).get("x-sapiom-workflow-token"),
          ).toBe("resume");
        }
        if (capabilityDelivery === "executions") {
          const key = new Headers(submit.init.headers).get("idempotency-key");
          expect(key).toBeTruthy();
          expect(key).not.toBe("native-key");
        }
        observations.push({
          body: submit.init.body,
          result: JSON.parse(JSON.stringify(result)),
        });
      }
      expect(observations[1]).toEqual(observations[0]);
      expect(executionDeliveryEligible(fixture.id)).toBe(true);
    },
  );

  it("resolves explicit override, client origin and current ambient origin in order", async () => {
    const original = process.env.SAPIOM_BASE_URL;
    const urls: string[] = [];
    const fetch = async (url: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(url));
      return json({ results: [] });
    };
    try {
      process.env.SAPIOM_BASE_URL = "https://ambient.test";
      const transport = new Transport({
        apiKey: "fixture",
        coreBaseUrl: "https://client.test",
        fetch,
      });
      await webSearch({ query: "q" }, transport, "https://override.test");
      await webSearch({ query: "q" }, transport);
      process.env.SAPIOM_BASE_URL = "https://changed.test";
      await webSearch(
        { query: "q" },
        new Transport({ apiKey: "fixture", fetch }),
      );
      expect(urls.map((url) => new URL(url).origin)).toEqual([
        "https://override.test",
        "https://client.test",
        "https://changed.test",
      ]);
    } finally {
      if (original === undefined) delete process.env.SAPIOM_BASE_URL;
      else process.env.SAPIOM_BASE_URL = original;
    }
  });
});
