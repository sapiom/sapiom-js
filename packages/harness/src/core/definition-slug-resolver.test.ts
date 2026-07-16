import { describe, it, expect, vi } from "vitest";
import { createDefinitionSlugResolver } from "./definition-slug-resolver.js";

/** Builds a minimal fetch mock that returns a JSON body with a given status. */
function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response);
}

/** Builds a fetch mock that throws (simulates a network error). */
function makeThrowingFetch(error: Error = new Error("network error")): typeof fetch {
  return vi.fn().mockRejectedValue(error);
}

describe("createDefinitionSlugResolver", () => {
  it("resolves a definitionId to its slug on a 200 response", async () => {
    const fetchImpl = makeFetch(200, { id: "188", slug: "ic-diligence-orchestrator", name: "IC Diligence" });
    const resolver = createDefinitionSlugResolver({ apiKey: "test-key", fetchImpl });

    const slug = await resolver.resolve("188");

    expect(slug).toBe("ic-diligence-orchestrator");
  });

  it("calls the correct URL with the api key header", async () => {
    const fetchImpl = makeFetch(200, { slug: "my-agent" });
    const resolver = createDefinitionSlugResolver({
      apiKey: "my-api-key",
      baseUrl: "https://tools.sapiom.ai",
      fetchImpl,
    });

    await resolver.resolve("42");

    expect(fetchImpl).toHaveBeenCalledWith("https://tools.sapiom.ai/agents/v1/definitions/42", {
      headers: { "x-sapiom-api-key": "my-api-key" },
    });
  });

  it("returns null on a non-2xx response", async () => {
    const fetchImpl = makeFetch(404, { error: "not found" });
    const resolver = createDefinitionSlugResolver({ apiKey: "test-key", fetchImpl });

    const slug = await resolver.resolve("999");

    expect(slug).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const fetchImpl = makeThrowingFetch();
    const resolver = createDefinitionSlugResolver({ apiKey: "test-key", fetchImpl });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
  });

  it("returns null without calling fetch when apiKey is null", async () => {
    const fetchImpl = vi.fn();
    const resolver = createDefinitionSlugResolver({ apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the response body has no slug field", async () => {
    const fetchImpl = makeFetch(200, { id: "188", name: "My Agent" });
    const resolver = createDefinitionSlugResolver({ apiKey: "test-key", fetchImpl });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
  });

  it("caches a successful resolution so the second call does not fetch", async () => {
    const fetchImpl = makeFetch(200, { slug: "cached-agent" });
    const resolver = createDefinitionSlugResolver({ apiKey: "test-key", fetchImpl });

    const first = await resolver.resolve("188");
    const second = await resolver.resolve("188");

    expect(first).toBe("cached-agent");
    expect(second).toBe("cached-agent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache a null resolution (allows retry after transient failure)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return { ok: true, json: async () => ({ slug: "recovered" }) } as Response;
    });

    const resolver = createDefinitionSlugResolver({ apiKey: "test-key", fetchImpl });

    const first = await resolver.resolve("188");
    const second = await resolver.resolve("188");

    expect(first).toBeNull();
    expect(second).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null when slug field is not a string (wrong type in body)", async () => {
    const fetchImpl = makeFetch(200, { slug: 42 });
    const resolver = createDefinitionSlugResolver({ apiKey: "test-key", fetchImpl });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
  });
});
