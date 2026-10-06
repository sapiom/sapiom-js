import { createClient } from "../client.js";
import { createStubClient, type StubCallRecord } from "../stub/index.js";
import { Transport } from "../_client/index.js";
import {
  managedBrowserApi,
  runManagedSession,
  type ManagedBrowserSession,
} from "./managed.js";
import { BrowserAutomationHttpError } from "./errors.js";

const createPath = "/v1/browser/sessions";
const recoveryPath = (key: string) =>
  `/v1/browser/sessions/recovery/${encodeURIComponent(key)}`;
const closePath = (sessionId: string) =>
  `/v1/browser/sessions/${encodeURIComponent(sessionId)}`;

const success = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });
const failure = (status: number, body: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ statusCode: status, requestId: "request-1", ...body }),
    { status },
  );

function fixture(routes: Record<string, Response[]>) {
  const queues = Object.fromEntries(
    Object.entries(routes).map(([key, responses]) => [key, [...responses]]),
  );
  const requests: Array<{
    method: string;
    path: string;
    headers: Headers;
    body?: unknown;
  }> = [];
  const fetch = jest.fn(
    async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const method = init?.method ?? "GET";
      const path = new URL(requestUrl).pathname;
      requests.push({
        method,
        path,
        headers: new Headers(init?.headers),
        body:
          init?.body === undefined
            ? undefined
            : JSON.parse(init.body as string),
      });
      const key = `${method} ${path}`;
      const queue = queues[key];
      if (!queue?.length) throw new Error(`Unexpected request: ${key}`);
      const response = queue.length === 1 ? queue[0] : queue.shift()!;
      return response.clone();
    },
  );
  const transport = new Transport({ apiKey: "test-key", fetch });
  const sessions = managedBrowserApi(
    "https://fixture.test",
    transport,
  ).sessions;
  return { fetch, requests, sessions };
}

const session: ManagedBrowserSession = {
  sessionId: "session-1",
  cdpUrl: "ws://fixture.test/session-1",
};
const completedClose = () =>
  success({ status: "terminated", settlement: "completed" });
const pendingClose = () =>
  success({ status: "terminated", settlement: "pending" });
const sessionCreated = () => success(session);
const defaultRoutes = () => ({
  [`POST ${createPath}`]: [sessionCreated()],
  [`DELETE ${closePath(session.sessionId)}`]: [completedClose()],
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it("returns the callback result and closes the session once", async () => {
  const { requests, sessions } = fixture(defaultRoutes());
  const result = await runManagedSession(
    sessions,
    { recording: false },
    async () => "page title",
  );
  expect(result).toBe("page title");
  expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  expect(requests.at(-1)).toMatchObject({
    method: "DELETE",
    path: closePath("session-1"),
  });
});

it("runs through the explicit client", async () => {
  const { fetch } = fixture(defaultRoutes());
  const client = createClient({ apiKey: "test-key", fetch });
  const result = await client.browserAutomation.withManagedSession(
    { recording: false },
    async () => "client result",
  );
  expect(result).toBe("client result");
  expect(fetch).toHaveBeenCalledTimes(2);
  await client.shutdown();
});

it("closes after the callback throws and preserves its error", async () => {
  const { requests, sessions } = fixture(defaultRoutes());
  const error = new Error("callback failed");
  const promise = runManagedSession(
    sessions,
    { recording: false },
    async () => {
      throw error;
    },
  );
  await expect(promise).rejects.toBe(error);
  expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
});

it("retries uncertain creation with the same key and input", async () => {
  const { requests, sessions } = fixture({
    [`POST ${createPath}`]: [
      failure(502, { code: "temporarily_unavailable" }),
      sessionCreated(),
    ],
    [`DELETE ${closePath(session.sessionId)}`]: [completedClose()],
  });
  const promise = runManagedSession(
    sessions,
    { recording: false },
    async () => "retried",
  );
  await jest.advanceTimersByTimeAsync(2_000);
  expect(await promise).toBe("retried");
  const creates = requests.filter(
    ({ method, path }) => method === "POST" && path === createPath,
  );
  expect(creates).toHaveLength(2);
  expect(creates[0].body).toEqual(creates[1].body);
  expect(creates[0].headers.get("idempotency-key")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(creates[1].headers.get("idempotency-key")).toBe(
    creates[0].headers.get("idempotency-key"),
  );
});

it("recovers and closes a session after creation remains uncertain, then rethrows the creation error", async () => {
  const key = "create-key";
  const recovered = {
    status: "cleanup_only",
    sessions: [{ sessionId: "lost-1", status: "active", tags: [] }],
  };
  const { requests, sessions } = fixture({
    [`POST ${createPath}`]: [failure(502, { code: "temporarily_unavailable" })],
    [`GET ${recoveryPath(key)}`]: [
      success({ status: "unknown", sessions: [] }),
      success({ status: "unknown", sessions: [] }),
      success(recovered),
    ],
    [`DELETE ${closePath("lost-1")}`]: [completedClose()],
  });
  const fn = jest.fn(async () => "unused");
  const promise = runManagedSession(
    sessions,
    { recording: false, idempotencyKey: key },
    fn,
  );
  const rejected = expect(promise).rejects.toMatchObject({ status: 502 });
  await jest.advanceTimersByTimeAsync(210_000);
  await rejected;
  expect(fn).not.toHaveBeenCalled();
  expect(
    requests.filter(
      ({ method, path }) => method === "GET" && path === recoveryPath(key),
    ),
  ).toHaveLength(3);
  expect(
    requests.filter(
      ({ method, path }) => method === "DELETE" && path === closePath("lost-1"),
    ),
  ).toHaveLength(1);
});

it("retries pending close results until they complete", async () => {
  const { requests, sessions } = fixture({
    [`POST ${createPath}`]: [sessionCreated()],
    [`DELETE ${closePath(session.sessionId)}`]: [
      pendingClose(),
      completedClose(),
    ],
  });
  const onPendingClose = jest.fn();
  const promise = runManagedSession(
    sessions,
    { recording: false },
    async () => "closed",
    { onPendingClose },
  );
  await jest.advanceTimersByTimeAsync(5_000);
  expect(await promise).toBe("closed");
  expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(2);
  expect(onPendingClose).not.toHaveBeenCalled();
});

it("notifies once when close remains pending and swallows notification errors", async () => {
  const { requests, sessions } = fixture({
    [`POST ${createPath}`]: [sessionCreated()],
    [`DELETE ${closePath(session.sessionId)}`]: [pendingClose()],
  });
  const onPendingClose = jest
    .fn()
    .mockRejectedValue(new Error("notification failed"));
  const promise = runManagedSession(
    sessions,
    { recording: false },
    async () => "callback result",
    { onPendingClose },
  );
  await jest.advanceTimersByTimeAsync(100_000);
  expect(await promise).toBe("callback result");
  expect(
    requests.filter(({ method }) => method === "DELETE").length,
  ).toBeGreaterThan(1);
  expect(onPendingClose).toHaveBeenCalledTimes(1);
  expect(onPendingClose).toHaveBeenCalledWith(session.sessionId);
});

it("treats a missing session on close as already closed", async () => {
  const { requests, sessions } = fixture({
    [`POST ${createPath}`]: [sessionCreated()],
    [`DELETE ${closePath(session.sessionId)}`]: [
      failure(404, { code: "not_found" }),
    ],
  });
  const onPendingClose = jest.fn();
  const result = await runManagedSession(
    sessions,
    { recording: false },
    async () => "result",
    { onPendingClose },
  );
  expect(result).toBe("result");
  expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  expect(onPendingClose).not.toHaveBeenCalled();
});

it("uses a caller-supplied idempotency key", async () => {
  const { requests, sessions } = fixture(defaultRoutes());
  await runManagedSession(
    sessions,
    { recording: false, idempotencyKey: "caller-key" },
    async () => undefined,
  );
  expect(
    requests
      .find(({ method }) => method === "POST")
      ?.headers.get("idempotency-key"),
  ).toBe("caller-key");
});

it("does not retry or recover after a certain creation error", async () => {
  const { requests, sessions } = fixture({
    [`POST ${createPath}`]: [failure(400, { code: "invalid_input" })],
  });
  const fn = jest.fn(async () => "unused");
  const promise = runManagedSession(sessions, { recording: false }, fn);
  await expect(promise).rejects.toBeInstanceOf(BrowserAutomationHttpError);
  expect(
    requests.filter(
      ({ method, path }) => method === "POST" && path === createPath,
    ),
  ).toHaveLength(1);
  expect(requests.filter(({ method }) => method === "GET")).toHaveLength(0);
  expect(fn).not.toHaveBeenCalled();
});

it("routes stub calls through the session lifecycle overrides", async () => {
  const calls: StubCallRecord[] = [];
  const closeManaged = jest.fn(() => ({
    status: "terminated",
    settlement: "completed",
  }));
  const client = createStubClient({
    overrides: {
      "browserAutomation.sessions.createManaged": () => ({
        sessionId: "override-session",
        cdpUrl: "ws://stub.local/x",
      }),
      "browserAutomation.sessions.closeManaged": closeManaged,
    },
    calls,
  });
  let receivedSessionId: string | undefined;
  await client.browserAutomation.withManagedSession(
    { recording: false },
    async (receivedSession) => {
      receivedSessionId = receivedSession.sessionId;
    },
  );
  expect(receivedSessionId).toBe("override-session");
  expect(closeManaged).toHaveBeenCalledWith("override-session");
  const createRecord = calls.find(
    ({ capability }) =>
      capability === "browserAutomation.sessions.createManaged",
  );
  expect(
    (createRecord?.args[0] as { idempotencyKey?: string }).idempotencyKey,
  ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  expect(calls.map(({ capability }) => capability)).toEqual([
    "browserAutomation.sessions.createManaged",
    "browserAutomation.sessions.closeManaged",
  ]);
  expect(calls[1].args).toEqual(["override-session"]);
});
