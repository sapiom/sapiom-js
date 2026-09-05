/**
 * launch() — dispatch-handle shape + workflow resume-token forwarding.
 *
 * Injects a fake fetch (no real network) to assert the launched RunHandle
 * satisfies DispatchHandle, and that the engine-injected resume token rides as a
 * header (never the body) only when present in the env — so standalone use is
 * unaffected.
 */
import { createClient } from "../index.js";
import { CODING_RESULT_SIGNAL, CodingRunHttpError } from "./index.js";

interface Capture {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  calls?: number;
}

function fakeLaunchFetch(capture?: Capture): typeof globalThis.fetch {
  return (async (_url: string, init: RequestInit = {}) => {
    if (capture) {
      capture.headers = init.headers as Record<string, string>;
      capture.body = init.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined;
      capture.calls = (capture.calls ?? 0) + 1;
    }
    return {
      ok: true,
      status: 202,
      json: async () => ({
        data: {
          id: "run-123",
          attributes: { status: "pending" },
          relationships: { execution_environment: { data: { id: "env-1" } } },
        },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("agent.coding.launch — dispatch handle", () => {
  it("returns a handle that satisfies DispatchHandle", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeLaunchFetch() });
    const handle = await sapiom.models.coding.launch({ task: "do a thing" });
    expect(handle.runId).toBe("run-123");
    expect(handle.dispatch).toEqual({
      correlationId: "run-123",
      resultSignal: CODING_RESULT_SIGNAL,
    });
  });

  it("CODING_RESULT_SIGNAL is the capability-stable terminal signal", () => {
    expect(CODING_RESULT_SIGNAL).toBe("models.coding.result");
  });

  it("sends only an attached repository's slug and attach performs no request", async () => {
    const capture: Capture = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeLaunchFetch(capture),
    });
    const repo = sapiom.repositories.attach(
      "external-looking",
      "https://github.com/acme/example.git",
    );

    expect(capture.calls).toBeUndefined();
    await sapiom.models.coding.launch({ task: "inspect", gitRepository: repo });

    expect(capture.calls).toBe(1);
    expect(capture.body).toMatchObject({
      task: "inspect",
      git_repository: "external-looking",
    });
    expect(JSON.stringify(capture.body)).not.toContain("github.com");
    expect(capture.body).not.toHaveProperty("clone_url");
    expect(capture.body).not.toHaveProperty("cloneUrl");
  });
});

describe("agent.coding.launch — deadlineMinutes", () => {
  it("sends the deadline as snake_case deadline_minutes", async () => {
    const capture: Capture = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeLaunchFetch(capture),
    });

    await sapiom.models.coding.launch({ task: "do a thing", deadlineMinutes: 30 });

    expect(capture.body).toMatchObject({ deadline_minutes: 30 });
    expect(capture.body).not.toHaveProperty("deadlineMinutes");
  });

  it("omits the key entirely when no deadline is given — not null, not 0", async () => {
    // The server has to tell "no deadline" (dispatch now) from "zero minutes",
    // so an unset deadline must not reach the wire at all.
    const capture: Capture = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeLaunchFetch(capture),
    });

    await sapiom.models.coding.launch({ task: "do a thing" });

    expect(capture.body).not.toHaveProperty("deadline_minutes");
  });
});

describe("agent.coding — awaiting_capacity is not terminal", () => {
  it("keeps polling a deferred run instead of resolving it", async () => {
    // A run parked on a deadline reports awaiting_capacity for as long as it
    // waits for a lane. Resolving there would hand the caller a null result.
    const statuses = ["awaiting_capacity", "awaiting_capacity", "completed"];
    let polls = 0;
    const fetch = (async (_url: string, init: RequestInit = {}) => {
      const isPost = (init.method ?? "GET") === "POST";
      const status = isPost ? "pending" : (statuses[polls++] ?? "completed");
      return {
        ok: true,
        status: isPost ? 202 : 200,
        json: async () => ({
          data: {
            id: "run-deferred",
            attributes: {
              status,
              summary: status === "completed" ? "done" : null,
              result: null,
              error: null,
            },
            relationships: { execution_environment: { data: { id: "env-1" } } },
          },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const sapiom = createClient({ apiKey: "k", fetch });

    const handle = await sapiom.models.coding.launch({
      task: "do a thing",
      deadlineMinutes: 30,
    });
    expect(await handle.status()).toBe("awaiting_capacity");

    const result = await handle.wait({ pollMs: 1 });

    expect(result.status).toBe("completed");
    expect(polls).toBe(statuses.length);
  });
});

describe("agent.coding — typed HTTP failures", () => {
  const repositoryMessage =
    "The requested git_repository is not an active Sapiom repository available to this tenant. " +
    "Use a repository returned by repositories.create(), repositories.get(), or repositories.list(). " +
    "repositories.attach() only rehydrates a previously returned Sapiom repository; it does not import an external repository.";

  it.each(["launch", "run"] as const)(
    "exposes status, code, requestId, and parsed JSON for a %s 404",
    async (operation) => {
      const body = {
        statusCode: 404,
        error: "repository_not_found",
        message: repositoryMessage,
        requestId: "req-123",
      };
      const fetch = (async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify(body),
      })) as unknown as typeof globalThis.fetch;
      const sapiom = createClient({ apiKey: "k", fetch });

      const error = await sapiom.models.coding[operation]({
        task: "inspect",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CodingRunHttpError);
      expect(error).toMatchObject({
        name: "CodingRunHttpError",
        status: 404,
        code: "repository_not_found",
        requestId: "req-123",
        body,
        message: repositoryMessage,
      });
    },
  );

  it("preserves non-JSON error text with null code and requestId", async () => {
    const fetch = (async () => ({
      ok: false,
      status: 502,
      text: async () => "upstream unavailable",
    })) as unknown as typeof globalThis.fetch;
    const sapiom = createClient({ apiKey: "k", fetch });

    await expect(
      sapiom.models.coding.launch({ task: "inspect" }),
    ).rejects.toMatchObject({
      name: "CodingRunHttpError",
      status: 502,
      code: null,
      requestId: null,
      body: "upstream unavailable",
    });
  });

  it.each(["status", "wait"] as const)(
    "uses the same typed error for handle.%s() polling",
    async (operation) => {
      const fetch = jest
        .fn()
        .mockImplementationOnce(fakeLaunchFetch())
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({ code: "run_not_found", requestId: "req-poll" }),
        } as Response) as unknown as typeof globalThis.fetch;
      const sapiom = createClient({ apiKey: "k", fetch });
      const handle = await sapiom.models.coding.launch({ task: "inspect" });

      await expect(handle[operation]()).rejects.toMatchObject({
        name: "CodingRunHttpError",
        status: 404,
        code: "run_not_found",
        requestId: "req-poll",
      });
    },
  );
});

describe("agent.coding.launch — workflow resume token", () => {
  const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("forwards the env token as the x-sapiom-workflow-token header", async () => {
    process.env[KEY] = "tok-abc";
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.models.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-abc");
  });

  it("omits the header outside a workflow (no env token)", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.models.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBeUndefined();
  });

  it("forwards an explicit createClient({ resumeToken }) — the in-process runtime path", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      resumeToken: "tok-explicit",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.models.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-explicit");
  });

  it("explicit resumeToken wins over the ambient env token", async () => {
    process.env[KEY] = "tok-env";
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      resumeToken: "tok-explicit",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.models.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-explicit");
  });
});
