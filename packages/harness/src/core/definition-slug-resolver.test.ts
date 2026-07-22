import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDefinitionSlugResolver } from "./definition-slug-resolver.js";

/** Builds a minimal fetch mock that returns a JSON body with a given status. */
function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

/** Builds a fetch mock that throws (simulates a network error). */
function makeThrowingFetch(
  error: Error = new Error("network error"),
): typeof fetch {
  return vi.fn().mockRejectedValue(error);
}

describe("createDefinitionSlugResolver", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Silence + capture the diagnostic the resolver logs on failure, so the
    // suite output stays clean and the log-once behaviour is assertable.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("resolves a definitionId to its slug on a 200 response", async () => {
    const fetchImpl = makeFetch(200, {
      id: "188",
      slug: "lease-abstractor",
      name: "Lease Abstractor",
    });
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    const slug = await resolver.resolve("188");

    expect(slug).toBe("lease-abstractor");
  });

  it("calls the correct URL with the api key header", async () => {
    const fetchImpl = makeFetch(200, { slug: "my-agent" });
    const resolver = createDefinitionSlugResolver({
      apiKey: "my-api-key",
      baseUrl: "https://tools.sapiom.ai",
      fetchImpl,
    });

    await resolver.resolve("42");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://tools.sapiom.ai/agents/v1/definitions/42",
      {
        headers: { "x-sapiom-api-key": "my-api-key" },
      },
    );
  });

  it("returns null on a non-2xx response", async () => {
    const fetchImpl = makeFetch(404, { error: "not found" });
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    const slug = await resolver.resolve("999");

    expect(slug).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const fetchImpl = makeThrowingFetch();
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
  });

  it("returns null without calling fetch when apiKey is null", async () => {
    const fetchImpl = vi.fn();
    const resolver = createDefinitionSlugResolver({
      apiKey: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the response body has no slug field", async () => {
    const fetchImpl = makeFetch(200, { id: "188", name: "My Agent" });
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
  });

  it("caches a successful resolution so the second call does not fetch", async () => {
    const fetchImpl = makeFetch(200, { slug: "cached-agent" });
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

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
      return {
        ok: true,
        json: async () => ({ slug: "recovered" }),
      } as Response;
    });

    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    const first = await resolver.resolve("188");
    const second = await resolver.resolve("188");

    expect(first).toBeNull();
    expect(second).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null when slug field is not a string (wrong type in body)", async () => {
    const fetchImpl = makeFetch(200, { slug: 42 });
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    const slug = await resolver.resolve("188");

    expect(slug).toBeNull();
  });

  it("logs a resolution failure once per definitionId, not on every poll", async () => {
    const fetchImpl = makeFetch(404, { error: "not found" });
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    // Null isn't cached, so all three lookups hit the network — but only the
    // first failure is logged (the panel polls this endpoint continuously).
    await resolver.resolve("777");
    await resolver.resolve("777");
    await resolver.resolve("777");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("definitionId=777");
    expect(String(errorSpy.mock.calls[0][0])).toContain("HTTP 404");
  });

  it("does not log when there is no api key (a harness without auth is expected)", async () => {
    const resolver = createDefinitionSlugResolver({
      apiKey: null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await resolver.resolve("188");

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
