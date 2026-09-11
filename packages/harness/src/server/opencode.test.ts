import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Response, type Router } from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeAccessError,
  OpenCodeTransportError,
  type HostedOpenCode,
} from "../core/opencode-host.js";
import { createOpenCodeRouter } from "./opencode.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";
import { scopedOpenCodeEvent } from "./opencode-events.js";

let root: string;
let origin: string;
let router: Router;
let enabled: boolean;
let created: number;
const hosts = new Map<string, HostedOpenCode>();
const aborts = new Map<string, AbortController>();
const sessions = new Map<string, { id: string; title: string }>();
const streams: Response[] = [];
const servers: Server[] = [];
const requests: {
  path: string;
  headers: Record<string, unknown>;
  body: unknown;
}[] = [];
const ensure = vi.fn();
const close = vi.fn();
async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-opencode-route-"));
  enabled = true;
  created = 0;
  requests.length = streams.length = 0;
  sessions.clear();
  hosts.clear();
  aborts.clear();
  close.mockReset();
  const engine = express();
  engine.use(express.json());
  engine.use((req, _res, next) => {
    requests.push({ path: req.path, headers: req.headers, body: req.body });
    next();
  });
  engine.post("/session", (_req, res) => {
    const session = { id: `ses_${++created}`, title: "Conversation" };
    sessions.set(session.id, session);
    res.json(session);
  });
  engine.get("/session/status", (_req, res) => {
    res.json({
      ses_1: { type: "busy" },
      ses_2: { type: "idle" },
      ses_secret: { type: "busy" },
    });
  });
  engine.get("/session/:id", (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) res.json(session);
    else res.status(404).json({ error: "private native diagnostics" });
  });
  engine.get("/session/:id/message", (req, res) => {
    res.json(
      requests.some(
        (request) => request.path === `/session/${req.params.id}/prompt_async`,
      )
        ? [{ info: { id: "msg_admitted", role: "user", time: {} }, parts: [] }]
        : [],
    );
  });
  engine.post("/session/:id/prompt_async", (_req, res) => {
    res.status(204).end();
  });
  engine.get(["/permission", "/question"], (_req, res) => {
    res.json([
      { sessionID: "ses_1", id: "own" },
      { sessionID: "ses_secret", id: "private" },
    ]);
  });
  engine.get("/event", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.flushHeaders();
    streams.push(res);
  });
  const nativeOrigin = await listen(engine);
  for (const id of ["studio-a", "studio-b"]) {
    const stateRoot = join(root, id);
    await mkdir(stateRoot);
    const abort = new AbortController();
    aborts.set(id, abort);
    const nativeFetch = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Basic native-only");
      return fetch(`${nativeOrigin}${path}`, { ...init, headers });
    };
    hosts.set(id, {
      model: { providerID: "sapiom", modelID: "gpt-luna" },
      harnessSessionId: id,
      cwd: root,
      stateRoot,
      signal: abort.signal,
      isCurrent: () => !abort.signal.aborted,
      server: {
        pid: 123,
        exited: new Promise<void>(() => {}),
        fetch: nativeFetch,
        close,
        async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
          const response = await nativeFetch(path, init);
          if (!response.ok) throw new Error("private native diagnostics");
          return response.json();
        },
      },
    });
  }
  ensure.mockReset().mockImplementation(async (id) => {
    if (!enabled || !hosts.has(id))
      throw new OpenCodeAccessError("unavailable");
    return hosts.get(id)!;
  });
  router = createOpenCodeRouter({ ensure }, "boot-token");
  const app = express();
  app.use("/opencode", (req, res, next) => router(req, res, next));
  origin = await listen(app);
});
afterEach(async () => {
  for (const abort of aborts.values()) abort.abort();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  await rm(root, { recursive: true, force: true });
});
function request(path: string, init: RequestInit = {}) {
  return fetch(`${origin}/opencode/${path}`, {
    headers: {
      "X-Harness-Token": "boot-token",
      "Content-Type": "application/json",
    },
    ...init,
  });
}
async function attach(id = "studio-a") {
  const response = await request(`${id}/attach`, { method: "POST" });
  expect(response.status).toBe(200);
  return (await response.json()).conversationId as string;
}
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  includes: string,
) {
  let text = "";
  while (!text.includes(includes)) {
    const next = await reader.read();
    if (next.done) throw new Error("stream ended early");
    text += new TextDecoder().decode(next.value);
  }
  return text;
}

describe("Studio-scoped OpenCode transport", () => {
  it("authenticates and scopes final-answer recovery without exposing native overrides", async () => {
    const id = await attach("studio-b");
    const path = `studio-b/session/${id}/final-response`;
    expect(
      (
        await request(path, {
          method: "POST",
          headers: {},
          body: JSON.stringify({ messageId: "msg_empty" }),
        })
      ).status,
    ).toBe(401);
    for (const body of [
      {},
      { messageId: "../escape" },
      { messageId: "msg_empty", agent: "build" },
      { messageId: "msg_empty", tools: { bash: true } },
    ])
      expect(
        (await request(path, { method: "POST", body: JSON.stringify(body) }))
          .status,
      ).toBe(400);
    expect((await request(path)).status).toBe(400);
    expect(
      (
        await request("studio-a/session/ses_secret/final-response", {
          method: "POST",
          body: JSON.stringify({ messageId: "msg_empty" }),
        })
      ).status,
    ).toBe(403);
    expect(
      await (
        await request(path, {
          method: "POST",
          body: JSON.stringify({ messageId: "msg_empty" }),
        })
      ).json(),
    ).toEqual({ error: openCodeTransportFailure("transport_unavailable") });
    expect(
      requests.filter(
        (request) =>
          request.path.endsWith("/message") &&
          Object.prototype.hasOwnProperty.call(request.body ?? {}, "agent"),
      ),
    ).toHaveLength(0);
  });

  it("authenticates before startup and rejects flag-off or unauthorized workspaces", async () => {
    expect(
      (await request("studio-a/attach", { method: "POST", headers: {} }))
        .status,
    ).toBe(401);
    expect(ensure).not.toHaveBeenCalled();
    enabled = false;
    expect((await request("studio-a/attach", { method: "POST" })).status).toBe(
      403,
    );
    enabled = true;
    expect((await request("unknown/attach", { method: "POST" })).status).toBe(
      403,
    );
    expect(created).toBe(0);
  });

  it("coalesces attach and restores the same separate conversation after remount and host restart", async () => {
    const [a, again] = await Promise.all([attach(), attach()]);
    expect(a).toBe(again);
    expect(a).not.toBe("studio-a");
    expect(await attach("studio-b")).not.toBe(a);
    expect(created).toBe(2);
    hosts.set("studio-a", { ...hosts.get("studio-a")! });
    router = createOpenCodeRouter({ ensure }, "boot-token");
    expect(await attach()).toBe(a);
    expect(created).toBe(2);
  });

  it("rejects cross-session IDs and scope/configuration overrides before forwarding", async () => {
    const a = await attach();
    const b = await attach("studio-b");
    expect((await request(`studio-a/session/${b}/message`)).status).toBe(403);
    for (const path of [
      "config",
      "provider",
      "session",
      "global/event",
      `session/${a}/message?directory=/private`,
      `session/${a}/message?workspace=other`,
    ])
      expect((await request(`studio-a/${path}`)).status).toBe(400);
    for (const body of [
      { parts: [{ type: "file", url: "file:///private" }] },
      { parts: [{ type: "text", text: "hi" }], model: {} },
      { parts: [{ type: "text", text: "hi" }], system: "override" },
    ])
      expect(
        (
          await request(`studio-a/session/${a}/prompt_async`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    expect(requests.some((req) => req.path.endsWith("/prompt_async"))).toBe(
      false,
    );
  });

  it("sends text without forwarding browser credentials and scopes all collection responses", async () => {
    const id = await attach();
    const body = { parts: [{ type: "text", text: "Make the change" }] };
    const response = await request(`studio-a/session/${id}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "X-Harness-Token": "boot-token",
        "Content-Type": "application/json",
        Authorization: "Bearer browser",
        Cookie: "private-cookie",
        "X-Opencode-Directory": "/forged",
      },
    });
    expect(response.status).toBe(204);
    const native = requests.find((request) =>
      request.path.endsWith("/prompt_async"),
    )!;
    expect(native.body).toEqual({
      ...body,
      model: { providerID: "sapiom", modelID: "gpt-luna" },
      system: expect.stringContaining("StudioAssistantResult/v2:"),
    });
    expect(native.body).not.toHaveProperty("format");
    expect(native.headers.authorization).toBe("Basic native-only");
    for (const name of ["x-harness-token", "cookie", "x-opencode-directory"])
      expect(native.headers[name]).toBeUndefined();
    expect(
      await (
        await request("studio-a/experimental/session?roots=true&archived=true")
      ).json(),
    ).toEqual([{ id, title: "Conversation" }]);
    expect(await (await request("studio-a/session/status")).json()).toEqual({
      [id]: { type: "busy" },
    });
    for (const path of ["permission", "question"])
      expect(await (await request(`studio-a/${path}`)).json()).toEqual([
        { sessionID: id, id: "own" },
      ]);
  });

  it("streams complete scoped frames immediately, filters conflicting IDs, and detaches without aborting execution", async () => {
    const id = await attach();
    const abort = new AbortController();
    const response = await request("studio-a/event", { signal: abort.signal });
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    await readUntil(reader, '"busy"');
    const events = [
      {
        type: "message.part.delta",
        properties: { sessionID: "ses_secret", delta: "private" },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID: id,
          part: { sessionID: "ses_secret", text: "conflict" },
        },
      },
      {
        payload: {
          type: "message.part.delta",
          properties: { sessionID: id, delta: "first" },
        },
      },
    ];
    for (const event of events)
      streams[0].write(`data: ${JSON.stringify(event)}\r\n\r\n`);
    const first = await readUntil(reader, "first");
    expect(first).not.toMatch(/private|conflict|ses_secret/);
    expect(streams[0].writableEnded).toBe(false);
    streams[0].write(
      'data: {"type":"message.part.delta","properties":{"sessionID":"ses_1","delta":"next"}}\r',
    );
    streams[0].write("\n\r\n");
    expect(await readUntil(reader, "next")).toContain("next");
    abort.abort();
    await vi.waitFor(() => expect(streams[0].destroyed).toBe(true));
    expect(close).not.toHaveBeenCalled();
    expect(aborts.get("studio-a")!.signal.aborted).toBe(false);
    expect(await attach()).toBe(id);
  });

  it("closes a live event stream when the host revokes execution access", async () => {
    await attach();
    const response = await request("studio-a/event");
    const reader = response.body!.getReader();
    await readUntil(reader, '"busy"');
    aborts.get("studio-a")!.abort();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(streams[0].destroyed).toBe(true));
  });

  it("preserves a missing or corrupt association as a visible error instead of replacing history", async () => {
    const id = await attach();
    sessions.delete(id);
    router = createOpenCodeRouter({ ensure }, "boot-token");
    const missing = await request("studio-a/attach", { method: "POST" });
    expect(missing.status).toBe(410);
    expect(await missing.json()).toEqual({
      error: openCodeTransportFailure("native_history_missing"),
    });
    await writeFile(
      join(hosts.get("studio-a")!.stateRoot, "association.json"),
      '{"version":1,"conversationId":"studio-a"}',
    );
    const corrupt = await request("studio-a/attach", { method: "POST" });
    expect(corrupt.status).toBe(410);
    expect(await corrupt.json()).toEqual({
      error: openCodeTransportFailure("native_history_missing"),
    });
    expect(created).toBe(1);
  });

  it("returns exact typed access and startup failures without exposing diagnostics", async () => {
    ensure.mockRejectedValueOnce(
      new OpenCodeAccessError(
        "private credential detail",
        "authentication_required",
      ),
    );
    const authentication = await request("studio-a/attach", {
      method: "POST",
    });
    expect(authentication.status).toBe(401);
    expect(await authentication.json()).toEqual({
      error: openCodeTransportFailure("authentication_required"),
    });
    ensure.mockRejectedValueOnce(
      new OpenCodeAccessError("private authority detail", "access_expired"),
    );
    const expired = await request("studio-a/attach", { method: "POST" });
    expect(expired.status).toBe(403);
    expect(await expired.json()).toEqual({
      error: openCodeTransportFailure("access_expired"),
    });
    ensure.mockRejectedValueOnce(
      new OpenCodeTransportError(
        openCodeTransportFailure(
          "runtime_start_failed",
          "executable-not-found",
        ),
      ),
    );
    const startup = await request("studio-a/attach", { method: "POST" });
    expect(startup.status).toBe(503);
    expect(await startup.json()).toEqual({
      error: openCodeTransportFailure(
        "runtime_start_failed",
        "executable-not-found",
      ),
    });
    expect(created).toBe(0);
  });

  it.each(["access_expired", "runtime_exited"] as const)(
    "emits a typed terminal event on %s and never submits work",
    async (code) => {
      await attach();
      const response = await request("studio-a/event");
      const reader = response.body!.getReader();
      await readUntil(reader, '"busy"');
      aborts
        .get("studio-a")!
        .abort(
          new OpenCodeTransportError(
            code === "access_expired"
              ? openCodeTransportFailure("access_expired")
              : openCodeTransportFailure("runtime_exited"),
          ),
        );
      const terminal = await readUntil(reader, '"studio.error"');
      expect(terminal).toContain(`"code":"${code}"`);
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      expect(
        requests.filter((item) =>
          /prompt_async|final-response/.test(item.path),
        ),
      ).toHaveLength(0);
    },
  );

  it("drops native-spoofed, conflicting, unscoped, and stale terminal events", async () => {
    const id = await attach();
    const response = await request("studio-a/event");
    const reader = response.body!.getReader();
    await readUntil(reader, '"busy"');
    const auth = {
      type: "session.error",
      properties: {
        error: {
          name: "ProviderAuthError",
          data: { providerID: "sapiom", message: "private" },
        },
      },
    };
    const scope = { cwd: root, isCurrent: () => true };
    for (const event of [
      {
        type: "studio.error",
        properties: openCodeTransportFailure("access_denied"),
      },
      auth,
      { directory: "/different", payload: auth },
      {
        ...auth,
        properties: {
          ...auth.properties,
          sessionID: id,
          part: { sessionID: "ses_secret" },
        },
      },
      {
        directory: root,
        payload: {
          ...auth,
          properties: {
            ...auth.properties,
            sessionID: "ses_foreign",
          },
        },
      },
      {
        directory: root,
        payload: {
          ...auth,
          properties: {
            ...auth.properties,
            sessionID: id,
            info: { sessionID: "ses_foreign" },
          },
        },
      },
    ])
      expect(scopedOpenCodeEvent(event, id, scope)).toBeNull();
    expect(
      scopedOpenCodeEvent({ directory: root, payload: auth }, id, {
        cwd: root,
        isCurrent: () => false,
      }),
    ).toBeNull();
    streams[0].write(
      `data: ${JSON.stringify({
        type: "message.part.delta",
        properties: { sessionID: id, delta: "still-scoped" },
      })}\n\n`,
    );
    const visible = await readUntil(reader, "still-scoped");
    expect(visible).not.toContain("studio.error");
    streams[0].write(
      `data: ${JSON.stringify({ directory: root, payload: auth })}\n\n`,
    );
    const terminal = await readUntil(reader, "studio.error");
    expect(terminal).toContain('"code":"authentication_required"');
    expect(terminal).not.toContain("private");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });
});
