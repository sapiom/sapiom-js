import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDefinitionSlugResolver,
  type DefinitionSlugResolver,
} from "./definition-slug-resolver.js";

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

  it("logs an actionable sanitized failure once per definitionId, not on every poll", async () => {
    const fetchImpl = makeFetch(403, { error: "private upstream error" });
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
    expect(String(errorSpy.mock.calls[0][0])).toContain("HTTP 403");
    expect(String(errorSpy.mock.calls[0][0])).toContain(
      "account that owns this agent",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(
      /test-key|private upstream error/,
    );
    vi.mocked(fetchImpl).mockResolvedValue(reply({}, 503));
    await resolver.resolve("777");
    expect(errorSpy).toHaveBeenCalledTimes(2);
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
const delayedReply = () => {
  let release!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { response, release };
};

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
    [
      404,
      {
        statusCode: 404,
        code: "not_found",
        message: "Cannot GET /agents/v1/definitions/188",
      },
    ],
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
    [reply(ready), reply(absent, 404)],
    [
      reply(ready),
      reply({ activeBuildRunId: null, activeBuildRunStatus: null }),
    ],
    [reply(ready), reply({ ...ready, activeBuildRunId: "new-build" })],
    [reply(absent, 404), reply(ready)],
  ])(
    "reconciles healthy overlaps without caching runnable fields on failure",
    async (older, newer) => {
      const { response, release } = delayedReply();
      const fetchImpl = vi
        .fn()
        .mockReturnValueOnce(response)
        .mockResolvedValueOnce(newer)
        .mockRejectedValue(new Error("offline"));
      const resolver = createDefinitionSlugResolver({
        apiKey: "key",
        fetchImpl,
      });
      const pending = resolver.resolveMetadata("188");
      const latest = await resolver.resolveMetadata("188");
      release(older);
      await expect(pending).resolves.toEqual(latest);
      await expect(resolver.resolveMetadata("188")).resolves.toEqual({
        status: "unavailable",
        lastConfirmedDeployed:
          latest.status === "available" &&
          latest.metadata.activeBuildRunStatus === "ready",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const slug = latest.status === "available" ? latest.metadata.slug : null;
      await expect(resolver.resolve("188")).resolves.toBe(slug);
    },
  );
  it("forgets cached slugs, retained flags and pending responses across A → B → A", async () => {
    let key: string | null = "a";
    const { response, release } = delayedReply();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(ready))
      .mockReturnValueOnce(response)
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

    describe("createDefinitionSlugResolver.listVisible (SAP-3214)", () => {
      let errorSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      });
      afterEach(() => {
        errorSpy.mockRestore();
      });

      // Gateway list rows; ids arrive as strings, numbers are tolerated.
      const ROWS = [
        {
          id: 4821,
          slug: "order-triage",
          name: "Order Triage",
          description: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          activeBuildRunId: "build-1",
          activeBuildRunStatus: "ready",
          isTemplate: false,
        },
        {
          id: "77",
          slug: "unbuilt",
          name: "Unbuilt",
          description: null,
          createdAt: "2026-09-02T00:00:00.000Z",
          activeBuildRunId: null,
          activeBuildRunStatus: null,
          isTemplate: false,
        },
      ];
      const response = (body: unknown, status = 200) =>
        ({ ok: status === 200, status, json: async () => body }) as Response;
      const visibleOf = (
        result: Awaited<ReturnType<DefinitionSlugResolver["listVisible"]>>,
      ) => (result.status === "available" ? result.visible : null);

      it("fetches the tenant-scoped list with the api key and keys rows by string id", async () => {
        const fetchImpl = makeFetch(200, ROWS);
        const resolver = createDefinitionSlugResolver({
          apiKey: "sk-list",
          baseUrl: "https://tools.sapiom.ai",
          fetchImpl,
        });

        const visible = visibleOf(await resolver.listVisible());

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(
          "https://tools.sapiom.ai/agents/v1/definitions",
          expect.objectContaining({
            headers: { "x-sapiom-api-key": "sk-list" },
          }),
        );
        expect(visible).not.toBeNull();
        expect([...visible!.keys()]).toEqual(["4821", "77"]);
        expect(visible!.get("4821")).toEqual({
          slug: "order-triage",
          activeBuildRunId: "build-1",
          activeBuildRunStatus: "ready",
        });
        expect(visible!.get("77")).toEqual({
          slug: "unbuilt",
          activeBuildRunId: null,
          activeBuildRunStatus: null,
        });
      });

      it("is unavailable without fetching or logging when signed out", async () => {
        const fetchImpl = vi.fn();
        const resolver = createDefinitionSlugResolver({
          apiKey: null,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        await expect(resolver.listVisible()).resolves.toEqual({
          status: "unavailable",
          lastConfirmedDeployed: new Map(),
        });

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it("is unavailable on a non-2xx response and logs that failure once, not per poll", async () => {
        const fetchImpl = makeFetch(500, { error: "boom" });
        const resolver = createDefinitionSlugResolver({
          apiKey: "sk",
          fetchImpl,
        });

        for (let i = 0; i < 3; i += 1)
          expect((await resolver.listVisible()).status).toBe("unavailable");

        // Nothing is cached (a later poll may succeed), but the console line is.
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain("HTTP 500");
      });

      it("is unavailable when fetch throws (network error)", async () => {
        const resolver = createDefinitionSlugResolver({
          apiKey: "sk",
          fetchImpl: makeThrowingFetch(new Error("ECONNREFUSED")),
        });

        expect((await resolver.listVisible()).status).toBe("unavailable");
        expect(String(errorSpy.mock.calls[0][0])).toContain(
          "network error or timeout",
        );
      });

      it("is unavailable when the body is not an array", async () => {
        const resolver = createDefinitionSlugResolver({
          apiKey: "sk",
          fetchImpl: makeFetch(200, { items: ROWS }),
        });

        expect((await resolver.listVisible()).status).toBe("unavailable");
        expect(errorSpy).toHaveBeenCalledTimes(1);
      });

      it("skips rows without a usable id instead of failing the whole list", async () => {
        const resolver = createDefinitionSlugResolver({
          apiKey: "sk",
          fetchImpl: makeFetch(200, [null, { slug: "no-id" }, ROWS[0]]),
        });

        const visible = visibleOf(await resolver.listVisible());

        expect([...visible!.keys()]).toEqual(["4821"]);
      });

      it("retains the last confirmed display bit through a list failure and forgets it on sign-out", async () => {
        let key: string | null = "sk";
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(response(ROWS))
          .mockResolvedValue(response({ error: "boom" }, 503));
        const resolver = createDefinitionSlugResolver({
          apiKey: () => key,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        expect((await resolver.listVisible()).status).toBe("available");
        await expect(resolver.listVisible()).resolves.toEqual({
          status: "unavailable",
          lastConfirmedDeployed: new Map([
            ["4821", true],
            ["77", false],
          ]),
        });

        key = null;
        await expect(resolver.listVisible()).resolves.toEqual({
          status: "unavailable",
          lastConfirmedDeployed: new Map(),
        });
      });

      it("shares one in-flight request between concurrent callers, then fetches again on the next pass", async () => {
        let respond!: (value: Response) => void;
        const fetchImpl = vi.fn().mockImplementation(
          () =>
            new Promise<Response>((resolve) => {
              respond = resolve;
            }),
        );
        const resolver = createDefinitionSlugResolver({
          apiKey: "sk",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        // /api/state and /api/workflows polling together.
        const first = resolver.listVisible();
        const second = resolver.listVisible();
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        respond(response(ROWS));
        const [a, b] = await Promise.all([first, second]);
        expect(a).toBe(b);
        expect(visibleOf(a)?.size).toBe(2);

        // Build status is mutable: nothing is kept once the request settles.
        fetchImpl.mockResolvedValue(response([]));
        expect(visibleOf(await resolver.listVisible())?.size).toBe(0);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });

      it("never shares an in-flight request across an account switch, and drops the stale one", async () => {
        let currentKey: string | null = "sk-account-a";
        const pending: Array<(value: Response) => void> = [];
        const fetchImpl = vi.fn().mockImplementation(
          () =>
            new Promise<Response>((resolve) => {
              pending.push(resolve);
            }),
        );
        const resolver = createDefinitionSlugResolver({
          apiKey: () => currentKey,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const before = resolver.listVisible();
        currentKey = "sk-account-b";
        const after = resolver.listVisible();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][1]).toEqual(
          expect.objectContaining({
            headers: { "x-sapiom-api-key": "sk-account-a" },
          }),
        );
        expect(fetchImpl.mock.calls[1][1]).toEqual(
          expect.objectContaining({
            headers: { "x-sapiom-api-key": "sk-account-b" },
          }),
        );

        pending[0]!(response(ROWS));
        pending[1]!(response([]));
        // Started under the old account: nothing from it may resolve.
        await expect(before).resolves.toEqual({
          status: "unavailable",
          lastConfirmedDeployed: new Map(),
        });
        expect(visibleOf(await after)?.size).toBe(0);
      });

      it("seeds the stable slug cache so resolve() needs no per-id request afterwards", async () => {
        const fetchImpl = makeFetch(200, ROWS);
        const resolver = createDefinitionSlugResolver({
          apiKey: "sk",
          fetchImpl,
        });

        await resolver.listVisible();

        await expect(resolver.resolve("4821")).resolves.toBe("order-triage");
        await expect(resolver.resolve("77")).resolves.toBe("unbuilt");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      });
    });
  });
});
