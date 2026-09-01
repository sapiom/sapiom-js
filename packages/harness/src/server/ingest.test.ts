import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeHookEvent } from "../core/collector/normalizer.js";
import { createSeqCounter } from "../core/collector/seq.js";
import { createEventStore } from "../core/collector/store.js";
import { PlannerGreetingCoordinator } from "../core/planner-greeting.js";
import { createSessionRecordReader } from "../core/session-record.js";
import type { SessionManager } from "../core/session-manager.js";
import type { AnalyticsEvent, HarnessSession } from "../shared/types.js";
import {
  createIngestRouter,
  processIngest,
  type IngestDeps,
  type IngestRouterOptions,
  type IngestSessionContext,
} from "./ingest.js";

const INGEST_TOKEN = "test-token";

function postIngest(baseUrl: string, body: unknown, token = INGEST_TOKEN) {
  return fetch(`${baseUrl}/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("createIngestRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  let stored: AnalyticsEvent[];
  let enqueued: AnalyticsEvent[];
  let resolved: Array<{
    harnessSessionId: string;
    agentSessionId: string;
    source: unknown;
  }>;
  let sessions: Map<string, IngestSessionContext>;

  function start(
    depsOverride: Partial<IngestDeps> = {},
    routerOptions: IngestRouterOptions = {},
  ) {
    stored = [];
    enqueued = [];
    resolved = [];
    sessions = new Map([
      [
        "session-1",
        {
          harness: "claude-code",
          userId: "user-1",
          tenantId: "tenant-1",
          machineId: "machine-1",
          agentSessionId: null,
        },
      ],
    ]);

    const deps: IngestDeps = {
      authenticate: (sessionId, token) =>
        sessionId === "session-1" && token === INGEST_TOKEN,
      normalize: normalizeHookEvent,
      resolveSession: (harnessSessionId) => sessions.get(harnessSessionId),
      onAgentSessionResolved: (harnessSessionId, agentSessionId, source) => {
        const session = sessions.get(harnessSessionId);
        if (!session) return false;
        if (session.agentSessionId !== null) {
          return session.agentSessionId === agentSessionId;
        }
        resolved.push({ harnessSessionId, agentSessionId, source });
        session.agentSessionId = agentSessionId;
        return true;
      },
      store: {
        append: async (event) => {
          stored.push(event);
        },
      },
      batcher: {
        enqueue: (event) => {
          enqueued.push(event);
        },
      },
      ...depsOverride,
    };

    const app = express();
    app.use(createIngestRouter(deps, routerOptions));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  beforeEach(() => {
    start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects requests without a valid bearer token", async () => {
    const res = await postIngest(baseUrl, { hookEvent: "SessionStart" }, "wrong-token");
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("rejects malformed bodies before credential lookup", async () => {
    const res = await postIngest(baseUrl, [], INGEST_TOKEN);
    expect(res.status).toBe(401);
    expect(stored).toEqual([]);
  });

  it("rate limits repeated ingest requests before unbounded processing", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    start({}, { rateLimitMax: 1 });

    const body = {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", prompt: "hello" },
    };
    const accepted = await postIngest(baseUrl, body);
    const limited = await postIngest(baseUrl, body);

    expect(accepted.status).toBe(200);
    expect(limited.status).toBe(429);
    await vi.waitFor(() => expect(stored).toHaveLength(1));
  });

  it("binds a valid bearer token to the body session id", async () => {
    start({
      authenticate: (sessionId, token) =>
        (sessionId === "session-1" && token === INGEST_TOKEN) ||
        (sessionId === "session-2" && token === "token-2"),
    });
    sessions.set("session-2", {
      harness: "claude-code",
      userId: "user-2",
      tenantId: "tenant-2",
      machineId: "machine-1",
      agentSessionId: null,
    });

    const forged = await postIngest(
      baseUrl,
      {
        hookEvent: "SessionStart",
        harnessSessionId: "session-2",
        payload: { session_id: "forged-agent" },
      },
      INGEST_TOKEN,
    );
    expect(forged.status).toBe(401);
    expect(stored).toEqual([]);

    const owned = await postIngest(
      baseUrl,
      {
        hookEvent: "SessionStart",
        harnessSessionId: "session-2",
        payload: { session_id: "owned-agent" },
      },
      "token-2",
    );
    expect(owned.status).toBe(200);
    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(stored[0]?.harnessSessionId).toBe("session-2");
  });

  it("responds 200 immediately and processes asynchronously", async () => {
    const res = await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", prompt: "hello" },
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(stored[0].type).toBe("prompt.submitted");
    expect(stored[0].tenantId).toBe("tenant-1");
    expect(stored[0].seq).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it("assigns a monotonically increasing seq per harnessSessionId, server-side", async () => {
    await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", prompt: "first" },
    });
    await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", prompt: "second" },
    });

    await vi.waitFor(() => expect(stored).toHaveLength(2));
    expect(stored.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("serializes a following hook behind the durable SessionStart identity commit", async () => {
    const identityCommit = deferred();
    const identityEntered = deferred();
    const context: IngestSessionContext = {
      harness: "claude-code",
      userId: "user-1",
      tenantId: "tenant-1",
      machineId: "machine-1",
      agentSessionId: null,
    };
    const appended: AnalyticsEvent[] = [];
    const decorated: AnalyticsEvent[] = [];
    const batched: AnalyticsEvent[] = [];
    const deps: IngestDeps = {
      authenticate: () => true,
      normalize: normalizeHookEvent,
      resolveSession: () => context,
      onAgentSessionResolved: async (_harnessId, agentSessionId) => {
        identityEntered.resolve();
        await identityCommit.promise;
        context.agentSessionId = agentSessionId;
        return true;
      },
      decorateEvent: (event) => {
        decorated.push(event);
        return event;
      },
      store: { append: async (event) => void appended.push(event) },
      batcher: { enqueue: (event) => batched.push(event) },
    };
    const seqCounter = createSeqCounter();
    const startProcessing = processIngest(
      {
        hookEvent: "SessionStart",
        harnessSessionId: "session-ordered",
        payload: { session_id: "agent-canonical", source: "startup" },
      },
      deps,
      seqCounter,
    );
    await identityEntered.promise;

    // A distinct deps wrapper models the other ingress adapter. Sharing the
    // server-owned counter is the ordering authority used by HTTP and Codex.
    const followerProcessing = processIngest(
      {
        hookEvent: "UserPromptSubmit",
        harnessSessionId: "session-ordered",
        payload: { session_id: "agent-forged", prompt: "after start" },
      },
      { ...deps },
      seqCounter,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(decorated).toEqual([]);
    expect(appended).toEqual([]);
    expect(batched).toEqual([]);

    identityCommit.resolve();
    await Promise.all([startProcessing, followerProcessing]);

    expect(appended.map((event) => event.type)).toEqual([
      "session.start",
      "prompt.submitted",
    ]);
    expect(appended.map((event) => event.agentSessionId)).toEqual([
      "agent-canonical",
      "agent-canonical",
    ]);
    expect(appended.map((event) => event.seq)).toEqual([1, 2]);
    expect(decorated).toHaveLength(2);
    expect(batched).toHaveLength(2);
  });

  it("lets a follower re-resolve the prior pin after a SessionStart commit failure", async () => {
    const identityCommit = deferred();
    const identityEntered = deferred();
    const context: IngestSessionContext = {
      harness: "claude-code",
      userId: "user-1",
      tenantId: "tenant-1",
      machineId: "machine-1",
      agentSessionId: "agent-prior",
    };
    const appended: AnalyticsEvent[] = [];
    const decorated: AnalyticsEvent[] = [];
    const deps: IngestDeps = {
      authenticate: () => true,
      normalize: normalizeHookEvent,
      resolveSession: () => context,
      onAgentSessionResolved: async () => {
        identityEntered.resolve();
        await identityCommit.promise;
        return true;
      },
      decorateEvent: (event) => {
        decorated.push(event);
        return event;
      },
      store: { append: async (event) => void appended.push(event) },
      batcher: { enqueue: () => {} },
    };
    const seqCounter = createSeqCounter();
    const startProcessing = processIngest(
      {
        hookEvent: "SessionStart",
        harnessSessionId: "session-failed-start",
        payload: { session_id: "agent-proposed", source: "startup" },
      },
      deps,
      seqCounter,
    );
    await identityEntered.promise;
    const followerProcessing = processIngest(
      {
        hookEvent: "UserPromptSubmit",
        harnessSessionId: "session-failed-start",
        payload: { session_id: "agent-proposed", prompt: "after failure" },
      },
      deps,
      seqCounter,
    );
    await Promise.resolve();
    expect(appended).toEqual([]);
    expect(decorated).toEqual([]);

    identityCommit.reject(new Error("sessions registry unavailable"));
    await expect(startProcessing).rejects.toThrow("sessions registry unavailable");
    await followerProcessing;

    expect(context.agentSessionId).toBe("agent-prior");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "prompt.submitted",
      agentSessionId: "agent-prior",
      seq: 2,
    });
    expect(decorated).toHaveLength(1);
    expect(JSON.stringify(appended)).not.toContain("agent-proposed");
  });

  it("pins non-start events before the durable index so a forged vendor id cannot merge sessions", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "ingest-identity-test-"));
    try {
      const eventStore = createEventStore(join(stateDir, "events.ndjson"));
      start({
        authenticate: (sessionId, token) =>
          (sessionId === "session-1" || sessionId === "session-2") &&
          token === INGEST_TOKEN,
        store: eventStore,
      });
      sessions.get("session-1")!.agentSessionId = "agent-a";
      sessions.set("session-2", {
        harness: "claude-code",
        userId: "user-1",
        tenantId: "tenant-1",
        machineId: "machine-1",
        agentSessionId: "agent-b",
      });

      for (const [hookEvent, harnessSessionId, sessionId, text] of [
        ["UserPromptSubmit", "session-1", "agent-b", "A prompt"],
        ["Stop", "session-1", "agent-b", "A reply"],
        ["UserPromptSubmit", "session-2", "agent-b", "B prompt"],
        ["Stop", "session-2", "agent-b", "B reply"],
      ] as const) {
        const response = await postIngest(baseUrl, {
          hookEvent,
          harnessSessionId,
          payload:
            hookEvent === "UserPromptSubmit"
              ? { session_id: sessionId, prompt: text }
              : { session_id: sessionId, last_assistant_message: text },
        });
        expect(response.status).toBe(200);
      }

      await vi.waitFor(async () => {
        const index = await eventStore.index();
        expect(index.byAgentSession.get("agent-a")).toEqual(["session-1"]);
        expect(index.byAgentSession.get("agent-b")).toEqual(["session-2"]);
      });

      const reader = createSessionRecordReader(eventStore);
      const recordA = await reader.read("session-1");
      const recordB = await reader.read("session-2");
      expect(recordA?.mergedSessionIds).toEqual(["session-1"]);
      expect(recordA?.turns.map((turn) => turn.prompt)).toEqual(["A prompt"]);
      expect(recordB?.mergedSessionIds).toEqual(["session-2"]);
      expect(recordB?.turns.map((turn) => turn.prompt)).toEqual(["B prompt"]);
      const counts = await reader.turnCounts();
      expect(counts.get("agent-a")).toBe(1);
      expect(counts.get("agent-b")).toBe(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("links agentSessionId via onAgentSessionResolved on session.start", async () => {
    const res = await postIngest(baseUrl, {
      hookEvent: "SessionStart",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-42", source: "startup" },
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(resolved).toHaveLength(1));
    expect(resolved[0]).toEqual({
      harnessSessionId: "session-1",
      agentSessionId: "agent-42",
      source: "startup",
    });
  });

  it("ignores a SessionStart whose vendor identity conflicts with the pinned session", async () => {
    const ready: string[] = [];
    start({ onSessionReady: (harnessSessionId) => ready.push(harnessSessionId) });
    sessions.get("session-1")!.agentSessionId = "agent-pinned";

    const res = await postIngest(baseUrl, {
      hookEvent: "SessionStart",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-forged", source: "startup" },
    });
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessions.get("session-1")?.agentSessionId).toBe("agent-pinned");
    expect(resolved).toEqual([]);
    expect(ready).toEqual([]);
    expect(stored).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("awaits a durable identity persistence failure before readiness, storage, or batching", async () => {
    const ready: string[] = [];
    const errors: unknown[] = [];
    const identityCheck = vi.fn(async () => {
      await Promise.resolve();
      throw new Error("local sessions registry unavailable");
    });
    start({
      onAgentSessionResolved: identityCheck,
      onSessionReady: (harnessSessionId) => ready.push(harnessSessionId),
      onError: (error) => errors.push(error),
    });

    const res = await postIngest(baseUrl, {
      hookEvent: "SessionStart",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-partial-commit", source: "startup" },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(identityCheck).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(ready).toEqual([]);
    expect(stored).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("calls onSessionReady on session.start — the readiness signal SessionManager gates programmatic input on", async () => {
    const ready: string[] = [];
    start({ onSessionReady: (harnessSessionId) => ready.push(harnessSessionId) });

    const res = await postIngest(baseUrl, {
      hookEvent: "SessionStart",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-42", source: "startup" },
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(ready).toEqual(["session-1"]));
  });

  it("does not call onSessionReady for events other than SessionStart", async () => {
    const ready: string[] = [];
    start({ onSessionReady: (harnessSessionId) => ready.push(harnessSessionId) });

    await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", prompt: "hello" },
    });

    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(ready).toEqual([]);
  });

  it("rejects events for unknown sessions before processing", async () => {
    const res = await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "unknown-session",
      payload: { prompt: "hi" },
    });
    expect(res.status).toBe(401);

    // give the async handler a tick to (not) run
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stored).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it("drops hook events with no analytics mapping (PreToolUse) without storing", async () => {
    const res = await postIngest(baseUrl, {
      hookEvent: "PreToolUse",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", tool_name: "Bash" },
    });
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stored).toHaveLength(0);
  });

  it("runs transcript enrichment for Stop before storing", async () => {
    const enrichFromTranscript = vi.fn(async (event: AnalyticsEvent) => ({
      ...event,
      payload: { ...event.payload, model: "claude-sonnet-5" },
    }));
    start({ enrichFromTranscript });

    const res = await postIngest(baseUrl, {
      hookEvent: "Stop",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", transcript_path: "/tmp/fake.jsonl" },
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(enrichFromTranscript).toHaveBeenCalledTimes(1);
    expect(stored[0].payload.model).toBe("claude-sonnet-5");
  });

  it("calls onNormalizedEvent for every successfully normalized event", async () => {
    const onNormalizedEvent = vi.fn();
    start({ onNormalizedEvent });

    await postIngest(baseUrl, {
      hookEvent: "PostToolUse",
      harnessSessionId: "session-1",
      payload: {
        session_id: "agent-1",
        tool_name: "Bash",
        tool_input: "npm run dev",
        tool_response: "ready - started server on http://localhost:5555",
      },
    });

    await vi.waitFor(() => expect(onNormalizedEvent).toHaveBeenCalledTimes(1));
    const [event] = onNormalizedEvent.mock.calls[0];
    expect(event.type).toBe("tool.call");
    expect(event.payload.toolResponseSummary).toContain("localhost:5555");
  });

  it("keeps local annotations and sends only the telemetry projection remotely", async () => {
    start({
      decorateEvent: (event) => ({
        ...event,
        payload: { ...event.payload, plannerOrigin: "infrastructure" },
      }),
      projectTelemetryEvent: (event) => ({
        ...event,
        payload: { planner: true, origin: event.payload.plannerOrigin },
      }),
    });

    await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1", prompt: "private control prompt" },
    });

    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(stored[0].payload).toMatchObject({
      prompt: "private control prompt",
      plannerOrigin: "infrastructure",
    });
    expect(enqueued[0].payload).toEqual({
      planner: true,
      origin: "infrastructure",
    });
    expect(JSON.stringify(enqueued[0])).not.toContain("private control prompt");
  });

  it("bounds hostile planner source, model, and usage before batching", async () => {
    const planningSession = {
      agentSessionId: "agent-1",
      planning: {
        identity: {
          projectId: "project-1",
          sessionId: "session-1",
          userId: "user-1",
          role: "map-planner",
        },
      },
    } as unknown as HarnessSession;
    const privacy = new PlannerGreetingCoordinator({
      root: "/unused",
      sessionManager: {
        get: () => planningSession,
      } as unknown as SessionManager,
    });
    start({
      enrichFromTranscript: async (event) => ({
        ...event,
        payload: {
          ...event.payload,
          model: "secret/customer_key_123",
          usage: {
            inputTokens: 10 ** 30,
            outputTokens: -7,
            secret: "/private/customer-token",
          },
        },
      }),
      projectTelemetryEvent: (event) => privacy.redactForTelemetry(event),
    });

    await postIngest(baseUrl, {
      hookEvent: "SessionStart",
      harnessSessionId: "session-1",
      payload: {
        session_id: "agent-1",
        source: "/private/customer-token",
      },
    });
    await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "session-1",
      payload: {
        session_id: "/private/envelope-secret",
        prompt: "private prompt text",
      },
    });
    await postIngest(baseUrl, {
      hookEvent: "Stop",
      harnessSessionId: "session-1",
      payload: {
        session_id: "/private/envelope-secret",
        transcript_path: "/private/transcript.jsonl",
        last_assistant_message: "private assistant text",
      },
    });

    await vi.waitFor(() => expect(enqueued).toHaveLength(3));
    expect(enqueued.map((event) => event.payload)).toEqual([
      { planner: true, source: "unknown" },
      { planner: true, origin: "user" },
      {
        planner: true,
        hasAssistantText: true,
        modelReported: true,
        usage: { inputTokens: 1_000_000_000_000, outputTokens: null },
      },
    ]);
    expect(enqueued.map((event) => event.agentSessionId)).toEqual([
      null,
      null,
      null,
    ]);
    expect(stored.map((event) => event.agentSessionId)).toEqual([
      "agent-1",
      "agent-1",
      "agent-1",
    ]);
    expect(JSON.stringify(enqueued)).not.toContain("private");
    expect(JSON.stringify(enqueued)).not.toContain("secret");
  });

  it("does not call onNormalizedEvent for a hook with no analytics mapping", async () => {
    const onNormalizedEvent = vi.fn();
    start({ onNormalizedEvent });

    await postIngest(baseUrl, {
      hookEvent: "PreToolUse",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1" },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onNormalizedEvent).not.toHaveBeenCalled();
  });
});
