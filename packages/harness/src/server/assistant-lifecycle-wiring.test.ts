import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";

const auth = vi.hoisted(() => ({
  environment: null as ResolvedEnvironment | null,
  file: "",
}));
vi.mock("@sapiom/mcp/auth", async (original) => ({
  ...(await original<typeof import("@sapiom/mcp/auth")>()),
  resolveEnvironment: async () => structuredClone(auth.environment),
  readCredentials: async () => auth.environment?.credentials,
  readCredentialsOrThrow: async () => auth.environment?.credentials,
  credentialsFilePath: () => auth.file,
}));
vi.mock("@sapiom/opencode", async (original) => ({
  ...(await original<typeof import("@sapiom/opencode")>()),
  startOpenCodeServer: vi.fn(),
}));

import {
  parseStudioAssistantSystem,
  startOpenCodeServer,
  type OpenCodeServer,
} from "@sapiom/opencode";
import { startServer, type HarnessServer } from "./index.js";
import type { ActivatedAssistantContextRuntime } from "./assistant-context-runtime.js";
import { AssistantSessionStore } from "../core/assistant-session-store.js";
import { AssistantRecordStore } from "../core/assistant-record-store.js";
import { AssistantContinuationStore } from "../core/assistant-continuation-store.js";
import { FileAssistantSourceStore } from "../core/assistant-source-store.js";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import { LocalWorkspaceScopeCatalog } from "../core/workspace-scope-catalog.js";
import { resolveStatePaths } from "../core/paths.js";
import { projectAssistantRecord } from "../core/assistant-record.js";
import {
  contextAuthorityScope,
  nativeAuthorityScope,
} from "../core/assistant-authority.js";
import {
  composeAssistantPrompt,
  resolveStudioAssistantContext,
} from "../core/studio-assistant-context.js";
import type { AssistantGrant } from "../core/assistant-access.js";
import type { HostedOpenCode } from "../core/opencode-host.js";
import type { AssistantHistoryEntry } from "../shared/assistant-history.js";
import type { AssistantStateSnapshot } from "../shared/assistant-state.js";
import type {
  HarnessAdapter,
  HarnessSession,
  LaunchOpts,
} from "../shared/types.js";

const token = "wiring-only-boot-token";
const parentId = "11111111-1111-4111-8111-111111111111";
const nativeParent = "ses_saved_parent";
type Row = Record<string, unknown>;
type NativeMessage = { info: Row; parts: Row[] };
type Conversation = { info: Row; messages: NativeMessage[] };

let root: string, cwd: string, origin: string, api: Server;
let studio: HarnessServer | undefined;
let socket: WebSocket | undefined;
let events: Row[];
let grant: AssistantGrant;
let binding: {
  harnessSessionId: string;
  cwd: string;
  contextAuthorityScope: string;
  conversationId: string;
};
let stores: {
  sessions: AssistantSessionStore;
  records: AssistantRecordStore;
  continuations: AssistantContinuationStore;
};
let databases: Map<string, Map<string, Conversation>>;
let calls: { path: string; method: string; scope: string; body?: Row }[];
let launches: Parameters<typeof startOpenCodeServer>[0][];
let nativeCloses: string[];
let providerRequests: string[];
const profile = vi.fn(async () => "Current Studio profile");
const terminal = vi.fn((opts: LaunchOpts) => ({
  command: "bash",
  args: [],
  env: {},
  cwd: opts.cwd,
}));
const background = vi.fn(() => {
  throw new Error("Unexpected background task");
});
const prepareTerminal = vi.fn(async () => ({}));

/** Only the process/HTTP boundary is substituted; the assembled server uses
 * real authorization, associations, receipts, context delivery and durable stores. */
async function nativeStart(
  options: Parameters<typeof startOpenCodeServer>[0],
): Promise<OpenCodeServer> {
  launches.push(options);
  const scope = basename(dirname(options.stateRoot));
  const database = databases.get(scope) ?? new Map<string, Conversation>();
  databases.set(scope, database);
  await mkdir(options.stateRoot, { recursive: true });
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const fetchNative = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    init.signal?.throwIfAborted();
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Row) : undefined;
    calls.push({ path, method, scope, body });
    const route = new URL(path, "http://native.local").pathname;
    if (route === "/event")
      return new Response(new ReadableStream(), {
        headers: { "Content-Type": "text/event-stream" },
      });
    if (route === "/mcp")
      return Response.json({ sapiom: { status: "connected" } });
    if (route === "/session/status") return Response.json({});
    if (["/permission", "/question"].includes(route)) return Response.json([]);
    if (route === "/session") {
      if (method === "GET")
        return Response.json([...database.values()].map(({ info }) => info));
      const id = `ses_${randomUUID().replace(/-/g, "")}`;
      const info = {
        ...body,
        id,
        directory: options.cwd,
        permission: [],
        time: { created: Date.now() },
      };
      database.set(id, { info, messages: [] });
      return Response.json(info);
    }
    const match =
      /^\/session\/(ses_[A-Za-z0-9_-]+)(?:\/(message|prompt_async|abort)(?:\/(msg_[A-Za-z0-9_-]+))?)?$/.exec(
        route,
      );
    const session = match && database.get(match[1]!);
    if (!session || !match)
      return Response.json({ error: "missing" }, { status: 404 });
    if (!match[2]) return Response.json(session.info);
    if (match[2] === "abort") return Response.json(true);
    if (method === "GET")
      return Response.json(
        match[3]
          ? session.messages.find((message) => message.info.id === match[3])
          : session.messages,
      );
    if (!body || !Array.isArray(body.parts))
      throw new Error("Missing native prompt body");
    const id =
      typeof body.messageID === "string"
        ? body.messageID
        : `msg_${randomUUID().replace(/-/g, "")}`;
    if (session.messages.some((message) => message.info.id === id))
      throw new Error("Unexpected repeated seed dispatch");
    const message: NativeMessage = {
      info: {
        id,
        sessionID: match[1],
        role: "user",
        agent: body.agent ?? "build",
        system: body.system,
        time: { created: Date.now() },
      },
      parts: body.parts.map((part, index) => ({
        ...(part as Row),
        id: (part as Row).id ?? `prt_${id}_${index}`,
        messageID: id,
        sessionID: match[1],
      })),
    };
    session.messages.push(message);
    if (body.noReply !== true) {
      const answer = `msg_answer_${session.messages.length}`;
      session.messages.push({
        info: {
          id: answer,
          sessionID: match[1],
          role: "assistant",
          parentID: id,
          agent: "build",
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [
          {
            id: `prt_${answer}`,
            messageID: answer,
            sessionID: match[1],
            type: "text",
            text: "Completed the explicit request.",
          },
        ],
      });
    }
    return match[2] === "message"
      ? Response.json(message)
      : new Response(null, { status: 204 });
  };
  return {
    pid: 980_000 + launches.length,
    exited,
    fetch: fetchNative,
    fetchJson: async <T>(path: string, init?: RequestInit) => {
      const response = await fetchNative(path, init);
      if (!response.ok) throw new Error("Native request failed");
      return (await response.json()) as T;
    },
    close: async () => {
      nativeCloses.push(scope);
      exit();
    },
  };
}

const request = (
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  fetch(`${origin}${path}`, {
    method,
    headers: {
      "X-Harness-Token": token,
      "Content-Type": "application/json",
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function json(path: string, method = "GET", body?: unknown) {
  const response = await request(path, method, body);
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value;
}
async function entries(): Promise<AssistantHistoryEntry[]> {
  return (
    await json(`/api/sessions/assistant-history?cwd=${encodeURIComponent(cwd)}`)
  ).entries;
}
async function header(id = parentId) {
  return json(`/opencode/${id}/lifecycle`);
}
async function socketSnapshot(): Promise<AssistantStateSnapshot> {
  const observer = new WebSocket(
    `ws://127.0.0.1:${studio!.port}/ws/events?token=${token}`,
  );
  return new Promise((resolve, reject) => {
    observer.once("message", (raw) => {
      observer.terminate();
      resolve(JSON.parse(raw.toString()).snapshot as AssistantStateSnapshot);
    });
    observer.once("error", reject);
  });
}
async function terminalRejection(id: string, credential = token) {
  const observer = new WebSocket(
    `ws://127.0.0.1:${studio!.port}/ws/terminal?session=${id}&token=${credential}`,
  );
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    observer.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
    observer.once("error", reject);
  });
}
function owner(): ActivatedAssistantContextRuntime {
  return { start: vi.fn(nativeStart), assertAvailable: vi.fn(async () => {}) };
}
async function boot(activated?: ActivatedAssistantContextRuntime) {
  const adapter: HarnessAdapter = {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: terminal,
    resume: (_id, opts) => terminal(opts),
    launchTask: background,
    canResume: async () => true,
    listPastSessions: async () => [],
  };
  studio = await startServer({
    port: 0,
    bootToken: token,
    telemetryOptIn: false,
    autoCreateSession: false,
    stateRoot: root,
    launchDir: cwd,
    claudeHomeDir: root,
    codexHomeDir: root,
    identity: {
      userId: grant.userId,
      tenantId: grant.tenantId,
      organizationName: "Fixture",
      apiKey: "sk_fixture",
      source: "cached",
    },
    adapters: { "claude-code": adapter },
    buildLaunchOpts: prepareTerminal,
    loadSystemPrompt: profile,
    ...(activated ? { assistantContextRuntime: activated } : {}),
  });
  origin = `http://127.0.0.1:${studio.port}`;
  await vi.waitFor(async () =>
    expect(await json("/api/assistant/access")).toMatchObject({
      enabled: true,
    }),
  );
  events = [];
  socket = new WebSocket(
    `ws://127.0.0.1:${studio.port}/ws/events?token=${token}`,
  );
  socket.on("message", (raw) => events.push(JSON.parse(raw.toString()) as Row));
  await new Promise<void>((resolve, reject) => {
    socket!.once("open", resolve);
    socket!.once("error", reject);
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-lifecycle-wiring-"));
  cwd = join(root, "project");
  await mkdir(cwd);
  databases = new Map();
  calls = [];
  launches = [];
  nativeCloses = [];
  providerRequests = [];
  profile.mockReset().mockResolvedValue("Current Studio profile");
  terminal.mockClear();
  background.mockClear();
  prepareTerminal.mockClear();
  vi.mocked(startOpenCodeServer).mockReset().mockImplementation(nativeStart);
  api = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/studio/capabilities")
      res.end(
        JSON.stringify({
          protocol: 1,
          assistant: true,
          userId: "user-fixture",
          tenantId: "tenant-fixture",
          identityRevision: "identity-fixture",
          maxAgeMs: 60_000,
          refreshAfterMs: 30_000,
        }),
      );
    else {
      providerRequests.push(req.url ?? "");
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiURL = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  auth.environment = {
    name: "staging",
    appURL: apiURL,
    apiURL,
    services: { llm: apiURL, mcp: apiURL },
    credentials: {
      apiKey: "sk_fixture",
      tenantId: "tenant-fixture",
      organizationName: "Fixture",
      apiKeyId: "key-fixture",
      studioCredentials: {
        accessToken: "sat_fixture",
        refreshToken: "srt_fixture",
        expiresAt: "2035-01-01T00:00:00.000Z",
      },
    },
  };
  auth.file = join(root, "credentials.json");
  await writeFile(
    auth.file,
    JSON.stringify({ environments: { staging: auth.environment } }),
  );
  grant = {
    userId: "user-fixture",
    tenantId: "tenant-fixture",
    identityRevision: "identity-fixture",
    expiresAt: Date.now() + 60_000,
    environment: auth.environment,
  };
  const paths = resolveStatePaths(root),
    catalog = new StudioProjectCatalog(paths.studioProjects);
  const project = await catalog.create("Recorded project");
  await catalog.addRootBinding(project.projectId, cwd);
  await catalog.reconcile(
    await new LocalWorkspaceScopeCatalog(() => [cwd]).list(),
  );
  const session: HarnessSession = {
    id: parentId,
    cwd,
    harness: "claude-code",
    title: "Recorded parent",
    agentSessionId: null,
    status: "exited",
    ready: false,
    exitCode: 0,
    boundWorkflowPath: null,
    rehydratedFrom: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    lastActiveAt: "2026-09-14T00:00:00.000Z",
    agentMapIdentity: {
      sessionId: parentId,
      projectId: project.projectId,
      userId: grant.userId,
    },
  };
  await writeFile(paths.sessions, JSON.stringify([session]));
  stores = {
    sessions: new AssistantSessionStore(root),
    records: new AssistantRecordStore(root),
    continuations: new AssistantContinuationStore(root),
  };
  binding = {
    harnessSessionId: parentId,
    cwd,
    contextAuthorityScope: contextAuthorityScope(grant, {
      harnessSessionId: parentId,
      cwd,
    }),
    conversationId: nativeParent,
  };
  await stores.sessions.associate(
    binding,
    nativeAuthorityScope(grant, binding),
    async () => nativeParent,
  );
  await stores.sessions.transition(parentId, 0, {
    lifecycle: "ended",
    execution: "paused",
  });
  const context = await resolveStudioAssistantContext({
    hosted: {
      harnessSessionId: parentId,
      cwd,
      signal: new AbortController().signal,
      isCurrent: () => true,
    } as HostedOpenCode,
    session: {
      id: parentId,
      cwd,
      projectId: project.projectId,
      boundAgentPath: null,
    },
    environment: "staging",
    workflows: [],
    capabilities: [],
    guidance: [
      {
        id: "studio-profile",
        kind: "profile",
        required: true,
        source: "fixture",
        revision: "1",
        status: "available",
        text: "Saved parent profile",
      },
    ],
  });
  const messages: NativeMessage[] = [
    {
      info: {
        id: "msg_parent",
        sessionID: nativeParent,
        role: "user",
        agent: "build",
        system: composeAssistantPrompt(context).system,
        time: { created: 1 },
      },
      parts: [
        {
          id: "prt_parent",
          messageID: "msg_parent",
          sessionID: nativeParent,
          type: "text",
          text: "Record the migration decision.",
        },
      ],
    },
    {
      info: {
        id: "msg_parent_answer",
        sessionID: nativeParent,
        role: "assistant",
        parentID: "msg_parent",
        agent: "build",
        finish: "stop",
        time: { created: 2, completed: 3 },
      },
      parts: [
        {
          id: "prt_parent_answer",
          messageID: "msg_parent_answer",
          sessionID: nativeParent,
          type: "text",
          text: "Keep the approved migration decision and wait for the next task.",
        },
      ],
    },
  ];
  databases.set(
    nativeAuthorityScope(grant, binding),
    new Map([
      [
        nativeParent,
        {
          info: { id: nativeParent, directory: cwd, permission: [] },
          messages,
        },
      ],
    ]),
  );
  await stores.records.write(projectAssistantRecord(messages, binding, 1));
});
afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  await studio?.close();
  await studio?.sessionManager.flush();
  studio = undefined;
  api?.closeAllConnections();
  if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});

it("mounts boot-authorized history and lifecycle routes without starting work; default Continue fails before allocation", async () => {
  await boot();
  expect(await entries()).toMatchObject([
    {
      harnessSessionId: parentId,
      recordRevision: 1,
      lifecycle: { lifecycle: "ended" },
    },
  ]);
  expect(
    (await json(`/api/sessions/${parentId}/assistant/record`)).record.turns,
  ).toHaveLength(1);
  const input = {
    expectedRevision: 1,
    expectedRecordRevision: 1,
    operationId: randomUUID(),
  };
  for (const path of [
    `/api/sessions/${parentId}/assistant/inspect`,
    `/api/sessions/${parentId}/assistant/resume`,
    `/api/sessions/${parentId}/assistant/continue`,
    `/opencode/${parentId}/attach`,
    `/api/sessions/${parentId}/terminal/start`,
  ])
    expect(
      (await request(path, "POST", input, { "X-Harness-Token": "not-boot" }))
        .status,
    ).toBe(401);
  expect(
    (
      await request(`/api/sessions/${parentId}`, "DELETE", undefined, {
        "X-Harness-Token": "not-boot",
      })
    ).status,
  ).toBe(401);
  const response = await request(
    `/api/sessions/${parentId}/assistant/continue`,
    "POST",
    input,
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "context_unavailable" },
  });
  expect(
    await stores.continuations.read(binding, input.operationId),
  ).toBeNull();
  expect(studio!.sessionManager.list().map(({ id }) => id)).toEqual([parentId]);
  expect(launches).toEqual([]);
  expect(terminal).not.toHaveBeenCalled();
  expect(background).not.toHaveBeenCalled();
  expect(profile).not.toHaveBeenCalled();
  expect(providerRequests).toEqual([]);
});

it("resumes saved inline context through the default launcher without dispatch or Terminal activation", async () => {
  await boot();
  const resumed = await json(
    `/api/sessions/${parentId}/assistant/resume`,
    "POST",
    { expectedRevision: 1, operationId: randomUUID() },
  );
  expect(resumed.session.id).toBe(parentId);
  expect(resumed.attachment.conversationId).toBe(nativeParent);
  expect(resumed.attachment.lifecycle).toMatchObject({
    lifecycle: "open",
    execution: "paused",
  });
  expect(startOpenCodeServer).toHaveBeenCalledOnce();
  expect(launches[0]).not.toHaveProperty("assistantContext");
  expect(calls.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(profile).not.toHaveBeenCalled();
  expect(terminal).not.toHaveBeenCalled();
  const ended = await json(`/api/sessions/${parentId}`, "DELETE");
  expect(ended.lifecycle.lifecycle).toBe("ended");
  expect(nativeCloses).toHaveLength(1);
  expect(studio!.sessionManager.get(parentId)).toBeDefined();
  expect(providerRequests).toEqual([]);
});

it("shares retained context across Continue, later Send and Resume while Terminal starts only explicitly", async () => {
  const activated = owner();
  await boot(activated);
  expect(await entries()).toHaveLength(1);
  expect(launches).toHaveLength(0);
  const input = {
    expectedRevision: 1,
    expectedRecordRevision: 1,
    operationId: randomUUID(),
  };
  const continued = await json(
    `/api/sessions/${parentId}/assistant/continue`,
    "POST",
    input,
  );
  const childId = continued.session.id as string;
  expect((await json("/api/state")).sessions).toContainEqual(
    expect.objectContaining({ id: childId }),
  );
  expect(await json("/api/sessions")).toContainEqual(
    expect.objectContaining({ id: childId }),
  );
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.status",
        session: expect.objectContaining({
          id: childId,
          terminalState: "not-started",
        }),
      }),
    ),
  );
  expect(childId).not.toBe(parentId);
  expect(continued.session).toMatchObject({
    terminalState: "not-started",
    status: "exited",
    agentSessionId: null,
  });
  expect(continued.attachment.lifecycle).toMatchObject({
    lifecycle: "open",
    execution: "paused",
  });
  expect(startOpenCodeServer).not.toHaveBeenCalled();
  expect(activated.start).toHaveBeenCalledOnce();
  expect(launches[0]!.assistantContext).toEqual({
    authorityScope: contextAuthorityScope(grant, {
      harnessSessionId: childId,
      cwd,
    }),
  });
  expect(
    calls.filter(
      ({ method, path }) => method === "POST" && path === "/session",
    ),
  ).toHaveLength(1);
  const seeded = calls.filter(
    ({ method, body }) => method === "POST" && body?.noReply === true,
  );
  expect(seeded).toHaveLength(1);
  expect(continued.continuation.seed.text).toContain(
    "approved migration decision",
  );
  expect(seeded[0]!.body).toMatchObject({
    messageID: continued.continuation.seed.messageId,
    noReply: true,
    parts: [
      {
        id: continued.continuation.seed.partId,
        synthetic: true,
        ignored: false,
        text: continued.continuation.seed.text,
      },
    ],
  });
  expect(
    calls.filter(({ path }) => path.endsWith("/prompt_async")),
  ).toHaveLength(0);
  expect(terminal).not.toHaveBeenCalled();
  expect(background).not.toHaveBeenCalled();
  expect(profile).toHaveBeenCalledOnce();
  const receipt = (await stores.continuations.readChild(childId))!;
  expect(receipt.phase).toBe("prepared");
  const childRoot = dirname(launches[0]!.stateRoot);
  const sourceOwner = new FileAssistantSourceStore(
    childRoot,
    receipt.childBinding!.contextAuthorityScope,
  );
  const accepted = await sourceOwner.readAccepted(
    receipt.acceptedRef!,
    receipt.acceptedRef!,
    new AbortController().signal,
  );
  expect(accepted.accepted.context.session.id).toBe(childId);
  expect(accepted.sources.get("studio-recorded-continuation")).toMatchObject({
    format: "utf8",
    text: receipt.brief.text,
  });
  const replayed = await json(
    `/api/sessions/${parentId}/assistant/continue`,
    "POST",
    input,
  );
  expect(replayed.session.id).toBe(childId);
  expect(calls.filter(({ body }) => body?.noReply === true)).toHaveLength(1);
  expect(profile).toHaveBeenCalledOnce();
  const attached = await json(`/opencode/${childId}/attach`, "POST", {
    expectedRevision: (await header(childId)).revision,
  });
  expect(attached.continuation).toEqual(continued.continuation);
  profile.mockResolvedValue("New explicit child profile");
  const sent = await request(
    `/opencode/${childId}/session/${attached.conversationId}/prompt_async`,
    "POST",
    { parts: [{ type: "text", text: "Now implement the next task." }] },
    { "X-Assistant-Lease": attached.lease },
  );
  expect(sent.status).toBe(204);
  const dispatched = calls.filter(({ path }) => path.endsWith("/prompt_async"));
  expect(dispatched).toHaveLength(1);
  const parsed = parseStudioAssistantSystem(
    dispatched[0]!.body!.system as string,
  );
  if (parsed.kind !== "accepted-v2")
    throw new Error("Expected child acceptance");
  expect(parsed.wire.accepted.acceptanceId).not.toBe(receipt.acceptanceId);
  const latest = await sourceOwner.readAccepted(
    parsed.wire.accepted,
    parsed.wire.accepted,
    new AbortController().signal,
  );
  expect(latest.sources.get("studio-recorded-continuation")).toMatchObject({
    format: "utf8",
    text: receipt.brief.text,
  });
  expect(
    [...latest.sources.values()]
      .map((source) => ("text" in source ? source.text : ""))
      .join("\n"),
  ).toContain("New explicit child profile");
  profile.mockRejectedValue(
    new Error("Recovery must not query live providers"),
  );
  const answer = databases
    .get(basename(childRoot))!
    .get(attached.conversationId)!
    .messages.at(-1)!;
  const recovered = await request(
    `/opencode/${childId}/session/${attached.conversationId}/final-response`,
    "POST",
    { messageId: answer.info.id },
    { "X-Assistant-Lease": attached.lease },
  );
  expect(recovered.status).toBe(204);
  const recovery = calls.filter(
    ({ body }) => body?.agent === "sapiom-turn-recovery",
  );
  expect(recovery).toHaveLength(1);
  expect(
    parseStudioAssistantSystem(recovery[0]!.body!.system as string),
  ).toMatchObject({
    kind: "accepted-v2",
    wire: { accepted: parsed.wire.accepted },
  });
  expect(profile).toHaveBeenCalledTimes(2);
  await json(`/api/sessions/${childId}`, "DELETE");
  profile.mockRejectedValue(new Error("Resume must not query live providers"));
  const resumed = await json(
    `/api/sessions/${childId}/assistant/resume`,
    "POST",
    {
      expectedRevision: (await header(childId)).revision,
      operationId: randomUUID(),
    },
  );
  expect(resumed.session.id).toBe(childId);
  expect(resumed.attachment.conversationId).toBe(attached.conversationId);
  expect(profile).toHaveBeenCalledTimes(2);
  expect(
    calls.filter(({ path }) => path.endsWith("/prompt_async")),
  ).toHaveLength(1);
  expect(terminal).not.toHaveBeenCalled();
  expect(prepareTerminal).not.toHaveBeenCalled();
  const started = await json(
    `/api/sessions/${childId}/terminal/start`,
    "POST",
    {},
  );
  expect(started.session ?? started).toMatchObject({
    id: childId,
    status: "running",
  });
  expect(terminal).toHaveBeenCalledOnce();
  expect(terminal.mock.calls[0]![0]).not.toHaveProperty("initialPrompt");
  expect(
    (await stores.sessions.association(receipt.childBinding!))?.conversationId,
  ).toBe(attached.conversationId);
  expect(
    (await request(`/api/sessions/${childId}/terminal/start`, "POST", {}))
      .status,
  ).toBe(200);
  expect(terminal).toHaveBeenCalledOnce();
  expect(background).not.toHaveBeenCalled();
  expect(providerRequests).toEqual([]);
}, 20_000);

it("hides an allocated but unprepared child across reboot and blocks attach before another native start", async () => {
  const workflow = join(cwd, "example-agent");
  await mkdir(workflow);
  await writeFile(
    join(workflow, "sapiom.json"),
    JSON.stringify({ definitionId: null }),
  );
  await writeFile(
    join(workflow, "package.json"),
    JSON.stringify({ name: "example-agent" }),
  );
  const canvas = join(cwd, ".sapiom", "canvas");
  await mkdir(canvas, { recursive: true });
  await writeFile(join(canvas, "index.html"), "<html>Authored canvas</html>");
  await writeFile(join(canvas, "asset.txt"), "Authored asset");
  const activated = {
    ...owner(),
    loadGuidance: async () => {
      throw new Error("Frozen source temporarily unavailable");
    },
  };
  await boot(activated);
  const operationId = randomUUID();
  const failed = await request(
    `/api/sessions/${parentId}/assistant/continue`,
    "POST",
    { expectedRevision: 1, expectedRecordRevision: 1, operationId },
  );
  expect(failed.status).toBe(503);
  const receipt = (await stores.continuations.read(binding, operationId))!;
  expect(receipt.phase).toBe("associated");
  const assertPrivate = async () => {
    expect(await json("/api/workflows")).toContainEqual(
      expect.objectContaining({ path: workflow }),
    );
    const state = await json("/api/state");
    expect(JSON.stringify(state)).not.toContain(receipt.childStudioId);
    expect(await json("/api/sessions")).not.toContainEqual(
      expect.objectContaining({ id: receipt.childStudioId }),
    );
    for (const [suffix, method, body] of [
      ["/terminal/start", "POST", {}],
      ["/resume", "POST", {}],
      ["/restart-mcp", "POST", {}],
      ["/workflow", "PATCH", { workflowPath: null }],
      ["/input", "POST", { text: "must not run" }],
      ["/record", "GET", undefined],
      ["/assistant/record", "GET", undefined],
      ["", "DELETE", undefined],
    ] as const)
      expect(
        (
          await request(
            `/api/sessions/${receipt.childStudioId}${suffix}`,
            method,
            body,
          )
        ).status,
        `${method} ${suffix}`,
      ).toBe(404);
    for (const [path, method, body] of [
      [
        "/api/macros/describe/run",
        "POST",
        {
          harnessSessionId: receipt.childStudioId,
          workflowPath: workflow,
          subject: "Must not run",
        },
      ],
      [
        "/api/macros/run_local/run",
        "POST",
        { harnessSessionId: receipt.childStudioId, workflowPath: workflow },
      ],
      [
        "/api/macros/visualize/run",
        "POST",
        { harnessSessionId: receipt.childStudioId },
      ],
      [`/api/canvas/${receipt.childStudioId}/render`, "POST", {}],
      [`/canvas/${receipt.childStudioId}`, "GET", undefined],
      [`/canvas/${receipt.childStudioId}/asset.txt`, "GET", undefined],
    ] as const)
      expect(
        (await request(path, method, body)).status,
        `${method} ${path}`,
      ).toBe(404);
    expect((await request(`/canvas/${parentId}`)).status).toBe(200);
    expect((await request(`/canvas/${parentId}/asset.txt`)).status).toBe(200);
    expect(await terminalRejection(receipt.childStudioId)).toEqual({
      code: 4004,
      reason: "session not found",
    });
    expect(
      await terminalRejection(receipt.childStudioId, "wrong-token"),
    ).toEqual({ code: 4001, reason: "unauthorized" });
    const unavailable = vi
      .spyOn(AssistantContinuationStore.prototype, "readChild")
      .mockRejectedValue(new Error("Index unavailable"));
    try {
      expect(
        (await request(`/api/sessions/${receipt.childStudioId}/record`)).status,
      ).toBe(404);
      expect(
        (await request(`/api/sessions/${receipt.childStudioId}`, "DELETE"))
          .status,
      ).toBe(404);
    } finally {
      unavailable.mockRestore();
    }
    expect(JSON.stringify(events)).not.toContain(receipt.childStudioId);
  };
  await assertPrivate();
  expect(events).not.toContainEqual(
    expect.objectContaining({
      type: "session.status",
      session: expect.objectContaining({ id: receipt.childStudioId }),
    }),
  );
  expect(studio!.sessionManager.get(receipt.childStudioId)?.terminalState).toBe(
    "not-started",
  );
  await studio!.close();
  studio = undefined;
  const before = launches.length;
  await boot(activated);
  await assertPrivate();
  expect(
    (await entries()).map(({ harnessSessionId }) => harnessSessionId),
  ).toEqual([parentId]);
  expect(
    (
      await request(`/opencode/${receipt.childStudioId}/attach`, "POST", {
        expectedRevision: (await header(receipt.childStudioId)).revision,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/api/sessions/${receipt.childStudioId}/assistant/resume`,
        "POST",
        {
          expectedRevision: (await header(receipt.childStudioId)).revision,
          operationId: randomUUID(),
        },
      )
    ).status,
  ).toBe(404);
  expect(launches).toHaveLength(before);
  expect(terminal).not.toHaveBeenCalled();
  expect(background).not.toHaveBeenCalled();
  expect(
    calls.filter(({ path }) => path.endsWith("/prompt_async")),
  ).toHaveLength(0);
  expect(providerRequests).toEqual([]);
}, 20_000);

it("ends only the selected live Terminal despite an unreadable continuation index", async () => {
  await boot(owner());
  const selected = await studio!.sessionManager.create({
    cwd,
    harness: "claude-code",
  });
  const neighbor = await studio!.sessionManager.create({
    cwd,
    harness: "claude-code",
  });
  const directory = join(root, "assistant-sessions", selected.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "continuation-preparation.json"), "not-json");
  expect(await json("/api/sessions")).not.toContainEqual(
    expect.objectContaining({ id: selected.id }),
  );
  expect(
    (
      await request(`/api/sessions/${selected.id}/input`, "POST", {
        text: "must not run",
      })
    ).status,
  ).toBe(404);
  const response = await request(`/api/sessions/${selected.id}`, "DELETE");
  expect(response.status).toBe(200);
  expect(studio!.sessionManager.isLive(selected.id)).toBe(false);
  expect(studio!.sessionManager.isLive(neighbor.id)).toBe(true);
  expect(studio!.sessionManager.get(selected.id)).toBeDefined();
}, 20_000);

it("keeps a prepared continuation visible after an older pending read finishes", async () => {
  const activated = {
    ...owner(),
    loadGuidance: async () => {
      throw new Error("Unavailable");
    },
  };
  await boot(activated);
  const operationId = randomUUID();
  const input = { expectedRevision: 1, expectedRecordRevision: 1, operationId };
  expect(
    (
      await request(
        `/api/sessions/${parentId}/assistant/continue`,
        "POST",
        input,
      )
    ).status,
  ).toBe(503);
  const receipt = (await stores.continuations.read(binding, operationId))!;
  Object.assign(activated, { loadGuidance: undefined });
  const read = AssistantContinuationStore.prototype.readChild;
  let enter!: () => void,
    release!: () => void,
    held = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(AssistantContinuationStore.prototype, "readChild")
    .mockImplementation(async function (this: AssistantContinuationStore, id) {
      const saved = await read.call(this, id);
      if (
        !held &&
        id === receipt.childStudioId &&
        saved?.phase !== "prepared"
      ) {
        held = true;
        enter();
        await wait;
      }
      return saved;
    });
  let pending: Promise<Response> | undefined;
  try {
    pending = request(`/api/sessions/${receipt.childStudioId}/record`);
    await entered;
    const completed = await json(
      `/api/sessions/${parentId}/assistant/continue`,
      "POST",
      input,
    );
    expect(completed.session.id).toBe(receipt.childStudioId);
    expect((await stores.continuations.read(binding, operationId))!.phase).toBe(
      "prepared",
    );
    release();
    expect((await pending).status).toBe(404);
    expect((await socketSnapshot()).lifecycles).toContainEqual(
      expect.objectContaining({ harnessSessionId: receipt.childStudioId }),
    );
  } finally {
    release();
    await pending;
    spy.mockRestore();
  }
}, 20_000);

it("publishes a new Assistant revision when visibility alone changes", async () => {
  await boot(owner());
  const before = await socketSnapshot();
  expect(before.lifecycles).toContainEqual(
    expect.objectContaining({ harnessSessionId: parentId }),
  );
  const read = AssistantContinuationStore.prototype.readChild;
  let unreadable = true;
  const spy = vi
    .spyOn(AssistantContinuationStore.prototype, "readChild")
    .mockImplementation(async function (this: AssistantContinuationStore, id) {
      if (id === parentId && unreadable) throw new Error("Read unavailable");
      return read.call(this, id);
    });
  try {
    await json("/api/sessions");
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "assistant.state",
          snapshot: expect.objectContaining({
            revision: before.revision + 1,
            lifecycles: [],
          }),
        }),
      ),
    );
    const hidden = await socketSnapshot();
    unreadable = false;
    await json("/api/sessions");
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "assistant.state",
          snapshot: expect.objectContaining({
            revision: hidden.revision + 1,
            lifecycles: before.lifecycles,
          }),
        }),
      ),
    );
  } finally {
    spy.mockRestore();
  }
}, 20_000);

it("publishes completed visibility reads while a newer refresh is still pending", async () => {
  await boot(owner());
  const read = AssistantContinuationStore.prototype.readChild;
  const entered: (() => void)[] = [],
    release: (() => void)[] = [];
  const starts = [0, 1].map(
    () => new Promise<void>((resolve) => entered.push(resolve)),
  );
  const gates = [0, 1].map(
    () => new Promise<void>((resolve) => release.push(resolve)),
  );
  let calls = 0;
  const spy = vi
    .spyOn(AssistantContinuationStore.prototype, "readChild")
    .mockImplementation(async function (this: AssistantContinuationStore, id) {
      if (id !== parentId || calls > 1) return read.call(this, id);
      const index = calls++;
      entered[index]!();
      await gates[index];
      if (index === 0) throw new Error("Index unavailable");
      return read.call(this, id);
    });
  const pending: Promise<Response>[] = [];
  try {
    pending.push(request("/api/sessions"));
    await starts[0];
    pending.push(request("/api/sessions"));
    await starts[1];
    release[0]!();
    expect(await (await pending[0]!).json()).toEqual([]);
    expect((await socketSnapshot()).lifecycles).toEqual([]);
    release[1]!();
    expect(await (await pending[1]!).json()).toContainEqual(
      expect.objectContaining({ id: parentId }),
    );
    expect((await socketSnapshot()).lifecycles).toContainEqual(
      expect.objectContaining({ harnessSessionId: parentId }),
    );
  } finally {
    release.forEach((resolve) => resolve());
    await Promise.allSettled(pending);
    spy.mockRestore();
  }
}, 20_000);
