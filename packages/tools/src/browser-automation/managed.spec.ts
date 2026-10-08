import { createClient } from "../client.js";
import { createStubClient } from "../stub/index.js";
import { Transport } from "../_client/index.js";
import { managedBrowserApi } from "./managed.js";
import { BrowserAutomationHttpError } from "./errors.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
/** Answer every request with the `{ data }` envelope of a successful response. */
const reply =
  (data: unknown, status = 200): typeof globalThis.fetch =>
  async () =>
    json({ data }, status);
/** Fail every request with the gateway's error body: top-level fields, no `{ data }` envelope. */
const fail =
  (status: number, body: Record<string, unknown>): typeof globalThis.fetch =>
  async () =>
    json({ statusCode: status, ...body, requestId: "request-1" }, status);

function fixture(
  impl: typeof globalThis.fetch = reply({
    taskId: "task-1",
    sessionId: "session-1",
    status: "running",
  }),
) {
  const fetch = jest.fn(impl);
  const transport = new Transport({ apiKey: "test-key", fetch });
  /** Each request the mock received, with its headers and parsed JSON body. */
  const sent = () =>
    fetch.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body:
        init?.body === undefined ? undefined : JSON.parse(init.body as string),
      signal: init?.signal,
    }));
  return {
    fetch,
    sent,
    api: managedBrowserApi("https://fixture.test", transport),
  };
}
const input = {
  sessionId: "session-1",
  instructions: "Open the fixture",
  maxSteps: 5,
  outputSchema: { type: "object" },
  idempotencyKey: "task-key",
};

it("uses the public task contract and preserves one key across retries", async () => {
  const { fetch, sent, api } = fixture();
  await api.tasks.start(input);
  await api.tasks.start(input);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const request of sent()) {
    expect(request.url).toBe("https://fixture.test/v1/browser/tasks");
    expect(request.headers.get("idempotency-key")).toBe("task-key");
    expect(request.headers.get("x-idempotency-key")).toBe("task-key");
    expect(request.headers.get("x-sapiom-api-key")).toBe("test-key");
    expect(request.body).toEqual({
      sessionId: "session-1",
      instructions: input.instructions,
      maxSteps: 5,
      outputSchema: input.outputSchema,
    });
  }
});

it("creates a managed session with explicit recording consent and server-owned defaults", async () => {
  const { sent, api } = fixture(
    reply({ sessionId: "session-1", cdpUrl: "wss://fixture.test" }),
  );
  expect(
    await api.sessions.createManaged({
      recording: false,
      profileId: "secret-profile-id",
      idempotencyKey: "create-key",
    }),
  ).toEqual({ sessionId: "session-1", cdpUrl: "wss://fixture.test" });
  const [request] = sent();
  expect(request.url).toBe("https://fixture.test/v1/browser/sessions");
  expect(request.body).toEqual({
    recording: false,
    profileId: "secret-profile-id",
  });
});

it("binds controls to task IDs and sends only response fields", async () => {
  const { sent, api } = fixture();
  await api.tasks.pause({ taskId: "task/1", idempotencyKey: "pause-key" });
  await api.tasks.resume({ taskId: "task/1", idempotencyKey: "resume-key" });
  await api.tasks.respond({
    taskId: "task/1",
    idempotencyKey: "respond-key",
    requestId: "input-1",
    response: "yes",
  });
  const requests = sent();
  expect(requests.map(({ url }) => url)).toEqual(
    ["pause", "resume", "respond"].map(
      (op) => `https://fixture.test/v1/browser/tasks/task%2F1/${op}`,
    ),
  );
  expect(requests[2].body).toEqual({
    requestId: "input-1",
    response: "yes",
  });
});

it("recovers a creation read-only with the original API key", async () => {
  const { sent, api } = fixture(
    reply({ status: "cleanup_only", sessions: [] }),
  );
  await api.sessions.recover("create-key");
  const [request] = sent();
  expect(request.headers.get("x-sapiom-api-key")).toBe("test-key");
  expect(request.url).toBe(
    "https://fixture.test/v1/browser/sessions/recovery/create-key",
  );
});

it("exposes the new methods through the explicit client and the local stub", async () => {
  const fetch = jest.fn(
    reply({ taskId: "task-1", sessionId: "session-1", status: "completed" }),
  );
  const client = createClient({ apiKey: "test-key", fetch });
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

it("saves and deletes secret profiles with stable mutation keys", async () => {
  const { sent, api } = fixture(
    reply({ profileId: "profile-1", status: "scheduled" }),
  );
  await api.profiles.save({
    sessionId: "session-1",
    idempotencyKey: "save-key",
  });
  await api.profiles.get("profile/1");
  await api.profiles.delete({
    profileId: "profile/1",
    idempotencyKey: "delete-key",
  });
  const requests = sent();
  expect(requests.map(({ url }) => url)).toEqual([
    "https://fixture.test/v1/browser/profiles",
    "https://fixture.test/v1/browser/profiles/profile%2F1",
    "https://fixture.test/v1/browser/profiles/profile%2F1",
  ]);
  expect(requests[0].body).toEqual({ sessionId: "session-1" });
  expect(requests[0].headers.get("idempotency-key")).toBe("save-key");
  expect(requests[2].method).toBe("DELETE");
  expect(requests[2].body).toBeUndefined();
  expect(requests[2].headers.get("idempotency-key")).toBe("delete-key");
});

it("controls recordings under their session and sends the same key on retry", async () => {
  const { sent, api } = fixture(reply({ status: "success" }));
  const control = { sessionId: "session/1", idempotencyKey: "record-key" };
  await api.recordings.pause(control);
  await api.recordings.pause(control);
  await api.recordings.resume({ ...control, idempotencyKey: "resume-key" });
  await api.recordings.list(control.sessionId);
  await api.recordings.delete({
    sessionId: control.sessionId,
    recordingId: "record/1",
  });
  const requests = sent();
  expect(requests.map(({ url }) => url)).toEqual(
    ["pause", "pause", "resume", "", "record%2F1"].map(
      (op) =>
        `https://fixture.test/v1/browser/sessions/session%2F1/recordings${op ? "/" + op : ""}`,
    ),
  );
  expect(requests[0].headers.get("idempotency-key")).toBe("record-key");
  expect(requests[1].headers.get("idempotency-key")).toBe("record-key");
  expect(requests[4].method).toBe("DELETE");
});

it("streams video bytes with range metadata, authentication, and cancellation", async () => {
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  const { sent, api } = fixture(
    async () =>
      new Response(bytes, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 0-7/100",
          "accept-ranges": "bytes",
        },
      }),
  );
  const controller = new AbortController();
  const response = await api.recordings.fetch({
    sessionId: "session/1",
    range: "bytes=0-7",
    signal: controller.signal,
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 0-7/100");
  expect(response.headers.get("content-type")).toBe("video/mp4");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  const [request] = sent();
  expect(request.url).toBe(
    "https://fixture.test/v1/browser/sessions/session%2F1/recordings/primary/fetch",
  );
  expect(request.headers.get("range")).toBe("bytes=0-7");
  expect(request.headers.get("x-sapiom-api-key")).toBe("test-key");
  expect(request.signal).toBe(controller.signal);
});

it("propagates an uncertain mutation once, keeping error details out of the message", async () => {
  const { api, fetch } = fixture(
    fail(409, {
      code: "browser_outcome_unknown",
      message: "private upstream detail",
    }),
  );
  const error = await api.tasks
    .start(input)
    .catch((error: BrowserAutomationHttpError) => error);
  expect(error).toBeInstanceOf(BrowserAutomationHttpError);
  expect(error).toMatchObject({
    status: 409,
    code: "browser_outcome_unknown",
    body: {
      code: "browser_outcome_unknown",
      message: "private upstream detail",
    },
  });
  expect((error as BrowserAutomationHttpError).message).toBe(
    "Browser request failed: HTTP 409",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retains a supplied top-level Sapiom code without inferring codes", async () => {
  const { api } = fixture(fail(409, { code: "browser_outcome_unknown" }));
  await expect(api.tasks.start(input)).rejects.toMatchObject({
    status: 409,
    code: "browser_outcome_unknown",
  });
});

it("does not retry a failed video request or parse it as successful media", async () => {
  const { api, fetch } = fixture(
    fail(502, { code: "upstream_unavailable", message: "Video not available" }),
  );
  await expect(
    api.recordings.fetch({ sessionId: "session-1" }),
  ).rejects.toMatchObject({ status: 502 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects invalid mutation keys before sending a profile or recording change", async () => {
  const { api, fetch } = fixture();
  await expect(
    api.profiles.save({ sessionId: "session-1", idempotencyKey: "bad key" }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    api.recordings.pause({ sessionId: "session-1", idempotencyKey: "" }),
  ).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a missing or dot-segment ID before sending a request", async () => {
  const { api, fetch } = fixture();
  // fetch resolves `..`, so this recording delete would otherwise close the session.
  await expect(
    api.recordings.delete({ sessionId: "session-1", recordingId: ".." }),
  ).rejects.toMatchObject({ status: 400, body: { error: "invalid_id" } });
  await expect(api.tasks.get("")).rejects.toMatchObject({ status: 400 });
  await expect(api.sessions.recover(".")).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    api.tasks.pause({
      taskId: undefined as unknown as string,
      idempotencyKey: "pause-key",
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});

it("binds profile and recording methods to the explicit client and Local Run overrides", async () => {
  const fetch = jest.fn(reply({ profileId: "profile-1", status: "ready" }));
  const client = createClient({ apiKey: "test-key", fetch });
  expect(
    (await client.browserAutomation.profiles.get("profile-1")).profileId,
  ).toBe("profile-1");
  await client.shutdown();
  const stub = createStubClient();
  expect(
    (
      await stub.browserAutomation.profiles.save({
        sessionId: "stub-session",
        idempotencyKey: "save-key",
      })
    ).profileId,
  ).toBe("stub-profile");
  expect(
    (await stub.browserAutomation.profiles.get("stub-profile")).status,
  ).toBe("ready");
  expect(
    (
      await stub.browserAutomation.profiles.delete({
        profileId: "stub-profile",
        idempotencyKey: "delete-key",
      })
    ).status,
  ).toBe("deleted");
  expect(
    (await stub.browserAutomation.recordings.list("stub-session")).items[0]
      .isPrimary,
  ).toBe(true);
  expect(
    (
      await stub.browserAutomation.recordings.pause({
        sessionId: "stub-session",
        idempotencyKey: "pause-key",
      })
    ).status,
  ).toBe("success");
  expect(
    (
      await stub.browserAutomation.recordings.resume({
        sessionId: "stub-session",
        idempotencyKey: "resume-key",
      })
    ).status,
  ).toBe("success");
  expect(
    (
      await stub.browserAutomation.recordings.delete({
        sessionId: "stub-session",
        recordingId: "primary",
      })
    ).status,
  ).toBe("deleted");
  const video = await stub.browserAutomation.recordings.fetch({
    sessionId: "stub-session",
  });
  expect(video.headers.get("content-type")).toBe("video/mp4");
  expect((await video.arrayBuffer()).byteLength).toBe(0);
});

it("uses Local Run overrides for profile readiness and streamed video", async () => {
  const stub = createStubClient({
    overrides: {
      "browserAutomation.profiles.get": {
        profileId: "profile-1",
        status: "scheduled",
      },
      "browserAutomation.recordings.fetch": () =>
        new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-range": "bytes 0-1/2",
          },
        }),
    },
  });
  expect((await stub.browserAutomation.profiles.get("profile-1")).status).toBe(
    "scheduled",
  );
  const response = await stub.browserAutomation.recordings.fetch({
    sessionId: "session-1",
    range: "bytes=0-1",
  });
  expect(response.status).toBe(206);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array([1, 2]),
  );
});
