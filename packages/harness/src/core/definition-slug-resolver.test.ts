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

  it("returns mutable build evidence with the stable slug", async () => {
    const fetchImpl = makeFetch(200, {
      slug: "lease-abstractor",
      activeBuildRunId: "build-17",
      activeBuildRunStatus: "ready",
    });
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(resolver.resolveMetadata("188")).resolves.toEqual({
      status: "available",
      metadata: {
        slug: "lease-abstractor",
        activeBuildRunId: "build-17",
        activeBuildRunStatus: "ready",
      },
    });
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
        signal: expect.any(AbortSignal),
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

  it("uses the current api key after a signed-out boot", async () => {
    let currentKey: string | null = null;
    const fetchImpl = makeFetch(200, {
      slug: "signed-in-agent",
      activeBuildRunId: "build-1",
      activeBuildRunStatus: "ready",
    });
    const resolver = createDefinitionSlugResolver({
      apiKey: () => currentKey,
      fetchImpl,
    });

    await expect(resolver.resolveMetadata("188")).resolves.toEqual({
      status: "unavailable",
      lastConfirmedDeployed: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    currentKey = "sk-after-login";
    await expect(resolver.resolveMetadata("188")).resolves.toMatchObject({
      status: "available",
      metadata: { slug: "signed-in-agent", activeBuildRunStatus: "ready" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), {
      headers: { "x-sapiom-api-key": "sk-after-login" },
      signal: expect.any(AbortSignal),
    });
  });

  it("does not cache mutable build status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          slug: "agent",
          activeBuildRunId: "build-1",
          activeBuildRunStatus: "building",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          slug: "agent",
          activeBuildRunId: "build-1",
          activeBuildRunStatus: "ready",
        }),
      } as Response);
    const resolver = createDefinitionSlugResolver({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(resolver.resolveMetadata("188")).resolves.toMatchObject({
      status: "available",
      metadata: { activeBuildRunStatus: "building" },
    });
    await expect(resolver.resolveMetadata("188")).resolves.toMatchObject({
      status: "available",
      metadata: { activeBuildRunStatus: "ready" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
    expect(String(errorSpy.mock.calls[0][0])).toContain("metadata unavailable");
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

const ready = {
  slug: "agent",
  activeBuildRunId: "build-1",
  activeBuildRunStatus: "ready",
};
const absent = { statusCode: 404, message: "Agent definition not found: 188" };
const reply = (body: unknown, status = 200) =>
  ({ ok: status === 200, status, json: async () => body }) as Response;

describe("authenticated deployment evidence", () => {
  it.each([
    [200, {}],
    [200, null],
    [200, []],
    [200, { ...ready, activeBuildRunId: null }],
    [200, { ...ready, activeBuildRunStatus: "" }],
    [200, { ...ready, activeBuildRunId: 1 }],
    [401, {}],
    [403, {}],
    [429, {}],
    [503, {}],
    [404, {}],
    [404, { ...absent, message: "wrong definition" }],
  ])(
    "retains confirmed evidence for unavailable %s %j",
    async (status, body) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(reply(ready))
        .mockResolvedValue(reply(body, status));
      const resolver = createDefinitionSlugResolver({
        apiKey: "key",
        fetchImpl,
      });
      await resolver.resolveMetadata("188");
      await expect(resolver.resolveMetadata("188")).resolves.toEqual({
        status: "unavailable",
        lastConfirmedDeployed: true,
      });
      await expect(resolver.resolveMetadata("other")).resolves.toEqual({
        status: "unavailable",
        lastConfirmedDeployed: null,
      });
    },
  );
  it.each([
    reply(absent, 404),
    reply({ activeBuildRunId: null, activeBuildRunStatus: null }),
  ])(
    "accepts confirmed absence over an older ready response",
    async (newer) => {
      let release!: (response: Response) => void;
      const fetchImpl = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValueOnce(newer)
        .mockRejectedValue(new Error("offline"));
      const resolver = createDefinitionSlugResolver({
        apiKey: "key",
        fetchImpl,
      });
      const pending = resolver.resolveMetadata("188");
      await resolver.resolveMetadata("188");
      release(reply(ready));
      await expect(pending).resolves.toEqual({
        status: "unavailable",
        lastConfirmedDeployed: false,
      });
      await expect(resolver.resolveMetadata("188")).resolves.toEqual({
        status: "unavailable",
        lastConfirmedDeployed: false,
      });
      await expect(resolver.resolve("188")).resolves.toBeNull();
    },
  );
  it("forgets cached slugs, retained flags and pending responses across A → B → A", async () => {
    let key: string | null = "a";
    let release!: (response: Response) => void;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(ready))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockRejectedValue(new Error("offline"));
    const resolver = createDefinitionSlugResolver({
      apiKey: () => key,
      fetchImpl,
    });
    await resolver.resolveMetadata("188");
    const pending = resolver.resolveMetadata("188");
    key = "b";
    resolver.invalidate();
    key = "a";
    resolver.invalidate();
    release(reply(ready));
    await expect(pending).resolves.toEqual({
      status: "unavailable",
      lastConfirmedDeployed: null,
    });
    await expect(resolver.resolve("188")).resolves.toBeNull();
    key = null;
    await expect(resolver.resolveMetadata("188")).resolves.toEqual({
      status: "unavailable",
      lastConfirmedDeployed: null,
    });
  });
  it("bounds network waits and treats timeout as unavailable", async () => {
    let signal!: AbortSignal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      signal = controller.signal;
      queueMicrotask(() => controller.abort());
      return signal;
    });
    const resolver = createDefinitionSlugResolver({
      apiKey: "key",
      fetchImpl: vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) =>
            init!.signal!.addEventListener("abort", () =>
              reject(new Error("timeout")),
            ),
          ),
      ),
    });
    try {
      await expect(resolver.resolveMetadata("188")).resolves.toEqual({
        status: "unavailable",
        lastConfirmedDeployed: null,
      });
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(signal.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
});
