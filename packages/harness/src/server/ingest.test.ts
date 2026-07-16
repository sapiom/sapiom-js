import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeHookEvent } from "../core/collector/normalizer.js";
import type { AnalyticsEvent } from "../shared/types.js";
import { createIngestRouter, type IngestDeps, type IngestSessionContext } from "./ingest.js";

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

describe("createIngestRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  let stored: AnalyticsEvent[];
  let enqueued: AnalyticsEvent[];
  let resolved: Array<{ harnessSessionId: string; agentSessionId: string }>;
  let sessions: Map<string, IngestSessionContext>;

  function start(depsOverride: Partial<IngestDeps> = {}) {
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
      ingestToken: INGEST_TOKEN,
      normalize: normalizeHookEvent,
      resolveSession: (harnessSessionId) => sessions.get(harnessSessionId),
      onAgentSessionResolved: (harnessSessionId, agentSessionId) => {
        resolved.push({ harnessSessionId, agentSessionId });
        const session = sessions.get(harnessSessionId);
        if (session) session.agentSessionId = agentSessionId;
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
    app.use(createIngestRouter(deps));
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

  it("links agentSessionId via onAgentSessionResolved on session.start", async () => {
    const res = await postIngest(baseUrl, {
      hookEvent: "SessionStart",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-42", source: "startup" },
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(resolved).toHaveLength(1));
    expect(resolved[0]).toEqual({ harnessSessionId: "session-1", agentSessionId: "agent-42" });
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

  it("drops events for unknown sessions without storing anything", async () => {
    const res = await postIngest(baseUrl, {
      hookEvent: "UserPromptSubmit",
      harnessSessionId: "unknown-session",
      payload: { prompt: "hi" },
    });
    expect(res.status).toBe(200);

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

  it("onIngestScheduled observes the fire-and-forget processing promise, settling only after processing completes", async () => {
    // The seam a short-lived host (CLI passthrough) uses as a teardown
    // barrier: the promise must cover the WHOLE pipeline — including slow
    // transcript enrichment — not just the fast 200 response.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduled: Array<Promise<void>> = [];
    start({
      enrichFromTranscript: async (event: AnalyticsEvent) => {
        await gate;
        return event;
      },
      onIngestScheduled: (processing) => scheduled.push(processing),
    });

    const res = await postIngest(baseUrl, {
      hookEvent: "Stop",
      harnessSessionId: "session-1",
      payload: { session_id: "agent-1" },
    });
    expect(res.status).toBe(200); // responded before processing finished

    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    let settled = false;
    void scheduled[0]!.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false); // still blocked inside enrichment
    expect(stored).toHaveLength(0);

    release();
    await scheduled[0];
    expect(stored).toHaveLength(1);
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
