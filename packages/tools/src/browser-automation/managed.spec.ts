import { createClient } from "../client.js";
import { createStubClient } from "../stub/index.js";
import { Transport } from "../_client/index.js";
import { managedBrowserApi } from "./managed.js";
import { BrowserAutomationHttpError } from "./errors.js";

function fixture(
  data: unknown = {
    taskId: "task-1",
    sessionId: "session-1",
    status: "running",
  },
  status = 200,
) {
  const fetch = jest.fn(
    async () => new Response(JSON.stringify({ data }), { status }),
  );
  const transport = new Transport({
    apiKey: "test-key",
    fetch: fetch as typeof globalThis.fetch,
  });
  return { fetch, api: managedBrowserApi("https://fixture.test", transport) };
}
const input = {
  sessionId: "session-1",
  instructions: "Open the fixture",
  maxSteps: 5,
  outputSchema: { type: "object" },
  idempotencyKey: "task-key",
};

it("uses the public task contract and preserves one key across retries", async () => {
  const { fetch, api } = fixture();
  await api.tasks.start(input);
  await api.tasks.start(input);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const call of fetch.mock.calls as unknown as Array<
    [string, RequestInit]
  >) {
    expect(call[0]).toBe("https://fixture.test/v1/browser/tasks");
    const headers = new Headers(call[1].headers);
    expect(headers.get("idempotency-key")).toBe("task-key");
    expect(headers.get("x-idempotency-key")).toBe("task-key");
    expect(headers.get("x-sapiom-api-key")).toBe("test-key");
    expect(JSON.parse(call[1].body as string)).toEqual({
      sessionId: "session-1",
      instructions: input.instructions,
      maxSteps: 5,
      outputSchema: input.outputSchema,
    });
  }
});

it("creates an owned session with explicit recording consent and bounded defaults", async () => {
  const { fetch, api } = fixture({
    sessionId: "session-1",
    cdpUrl: "wss://fixture.test",
  });
  expect(
    await api.sessions.createManaged({
      recording: false,
      idempotencyKey: "create-key",
    }),
  ).toEqual({ sessionId: "session-1", cdpUrl: "wss://fixture.test" });
  const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe("https://fixture.test/v1/browser/sessions");
  expect(JSON.parse(call[1].body as string)).toEqual({
    recording: false,
    idleTimeoutMinutes: 5,
    maxDurationMinutes: 20,
  });
});

it("binds controls to task IDs and sends only response fields", async () => {
  const { fetch, api } = fixture();
  await api.tasks.pause({ taskId: "task/1", idempotencyKey: "pause-key" });
  await api.tasks.resume({ taskId: "task/1", idempotencyKey: "resume-key" });
  await api.tasks.respond({
    taskId: "task/1",
    idempotencyKey: "respond-key",
    requestId: "input-1",
    response: "yes",
  });
  const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls.map(([url]) => url)).toEqual(
    ["pause", "resume", "respond"].map(
      (op) => `https://fixture.test/v1/browser/tasks/task%2F1/${op}`,
    ),
  );
  expect(JSON.parse(calls[2][1].body as string)).toEqual({
    requestId: "input-1",
    response: "yes",
  });
});

it("uses read-only recovery and propagates an uncertain mutation without another attempt", async () => {
  const { fetch, api } = fixture({ code: "browser_outcome_unknown" }, 409);
  await expect(api.tasks.start(input)).rejects.toBeInstanceOf(
    BrowserAutomationHttpError,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const recovery = fixture({ status: "cleanup_only", sessions: [] });
  await recovery.api.sessions.recover("create-key");
  expect((recovery.fetch.mock.calls[0] as unknown as [string])[0]).toBe(
    "https://fixture.test/v1/browser/sessions/recovery/create-key",
  );
});

it("exposes the new methods through the explicit client and the local stub", async () => {
  const fetch = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            taskId: "task-1",
            sessionId: "session-1",
            status: "completed",
          },
        }),
      ),
  );
  const client = createClient({
    apiKey: "test-key",
    fetch: fetch as typeof globalThis.fetch,
  });
  expect((await client.browserAutomation.tasks.get("task-1")).status).toBe(
    "completed",
  );
  await client.shutdown();
  const stub = createStubClient();
  const session = await stub.browserAutomation.sessions.createManaged({
    recording: false,
    idempotencyKey: "create-key",
  });
  expect(
    (
      await stub.browserAutomation.tasks.start({
        ...input,
        sessionId: session.sessionId,
      })
    ).status,
  ).toBe("completed");
  expect(
    (await stub.browserAutomation.sessions.closeManaged(session.sessionId))
      .settlement,
  ).toBe("completed");
});
