import { createClient } from "../client.js";
import { evaluate } from "../decisions/index.js";
import { Transport } from "./index.js";
import { executionDeliveryEligible } from "./execution-delivery.js";
import { resolveCoreBaseUrl } from "./capability-call.js";

const json = (value: unknown) => new Response(JSON.stringify(value));

describe("Core origin configuration", () => {
  it("trims trailing slashes while preserving long internal path segments", () => {
    const base = `https://core.test/${"/".repeat(250_000)}x`;
    expect(resolveCoreBaseUrl(base)).toBe(base);
    expect(resolveCoreBaseUrl(`${base}///`)).toBe(base);
    expect(resolveCoreBaseUrl("https://core.test/prefix///")).toBe(
      "https://core.test/prefix",
    );
  });

  it.each(["legacy", "executions"] as const)(
    "honors a decisions client origin while keeping decisions synchronous in %s mode",
    async (capabilityDelivery) => {
      const urls: string[] = [];
      const transport = new Transport({
        apiKey: "fixture",
        coreBaseUrl: "https://client.test/prefix/",
        capabilityDelivery,
        fetch: async (url) => {
          urls.push(String(url));
          return json({
            answers: {},
            usage: { inputTokens: 0, outputTokens: 0 },
          });
        },
      });
      const spec = { state: "fixture", questions: {} };
      await evaluate(spec, transport);
      await evaluate(spec, transport, "https://override.test/core/");
      expect(urls).toEqual([
        "https://client.test/prefix/v1/capabilities/decisions.evaluate",
        "https://override.test/core/v1/capabilities/decisions.evaluate",
      ]);
      expect(executionDeliveryEligible("decisions.evaluate")).toBe(false);
    },
  );

  it.each(["https://core.test/", "https://core.test/prefix/"])(
    "normalizes shared Core base %s for legacy search, media and key minting",
    async (coreBaseUrl) => {
      const urls: string[] = [];
      const client = createClient({
        apiKey: "fixture",
        coreBaseUrl,
        fetch: async (url) => {
          urls.push(String(url));
          if (String(url).endsWith("/scoped/workflow"))
            return json({
              plainKey: "scoped",
              apiKey: { id: "key", expiresAt: null, permissions: [] },
            });
          return json(
            String(url).includes("images") ? { images: [] } : { results: [] },
          );
        },
      });
      await client.search.webSearch({ query: "q" });
      await client.contentGeneration.images.create({ prompt: "scene" });
      await client.keys.mintScoped({ ttl: 60 });
      const base = coreBaseUrl.replace(/\/+$/, "");
      expect(urls).toEqual([
        `${base}/v1/capabilities/web.search`,
        `${base}/v1/capabilities/content.generation.images`,
        `${base}/v1/api-keys/scoped/workflow`,
      ]);
    },
  );
});
