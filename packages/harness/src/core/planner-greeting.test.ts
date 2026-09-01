import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsEvent, HarnessSession } from "../shared/types.js";
import type { SessionManager } from "./session-manager.js";
import {
  PlannerGreetingCoordinator,
  PlannerGreetingRetryUnavailableError,
  plannerGreetingPrompt,
} from "./planner-greeting.js";

function event(
  sessionId: string,
  type: AnalyticsEvent["type"],
  payload: Record<string, unknown>,
): AnalyticsEvent {
  return {
    eventId: `event-${type}`,
    seq: 1,
    ts: "2026-09-01T00:00:00.000Z",
    userId: "user-1",
    tenantId: null,
    machineId: "machine-1",
    harnessSessionId: sessionId,
    agentSessionId: "agent-1",
    harness: "codex",
    type,
    payload,
  };
}

function plannerSession(id = "session-1"): HarnessSession {
  return {
    id,
    agentSessionId: "agent-1",
    harness: "codex",
    cwd: "/private/project",
    title: "project",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActiveAt: "2026-09-01T00:00:00.000Z",
    exitCode: null,
    boundWorkflowPath: null,
    ready: true,
    planning: {
      identity: {
        projectId: "project-1",
        sessionId: id,
        userId: "user-1",
        role: "map-planner",
      },
      greeting: { status: "pending" },
      queuedInputIds: [],
    },
  };
}

describe("PlannerGreetingCoordinator", () => {
  let root: string;
  let session: HarnessSession;
  let submitted: string[];
  let manager: SessionManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "planner-greeting-"));
    session = plannerSession();
    submitted = [];
    manager = {
      get: (id: string) => (id === session.id ? session : undefined),
      setPlanningMetadata: async (_id: string, metadata: NonNullable<HarnessSession["planning"]>) => {
        session.planning = structuredClone(metadata);
      },
      submitInput: async (_id: string, text: string) => {
        submitted.push(text);
        return true;
      },
    } as unknown as SessionManager;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists one ready-gated greeting, then releases accepted input FIFO", async () => {
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await coordinator.onSessionStatus(session);
    expect(submitted).toHaveLength(1);
    const greeting = submitted[0]!;

    await coordinator.enqueue(session.id, "first user message");
    await coordinator.enqueue(session.id, "second user message");
    expect(submitted).toEqual([greeting]);

    const localPrompt = coordinator.decorateLocalEvent(
      event(session.id, "prompt.submitted", { prompt: greeting }),
    );
    expect(localPrompt.payload).toMatchObject({
      prompt: greeting,
      plannerOrigin: "infrastructure",
    });
    expect(coordinator.redactForTelemetry(localPrompt).payload).not.toHaveProperty(
      "prompt",
    );

    await coordinator.onEventPersisted(
      event(session.id, "turn.completed", { assistantText: "What should we build?" }),
    );
    expect(submitted).toEqual([
      greeting,
      "first user message",
      "second user message",
    ]);
    expect(session.planning).toMatchObject({
      greeting: { status: "delivered", messageId: "event-turn.completed" },
      queuedInputIds: [],
    });
    const durable = JSON.parse(
      await fs.readFile(
        path.join(root, session.id, "input-queue.json"),
        "utf8",
      ),
    ) as { inputs: unknown[] };
    expect(durable.inputs).toEqual([]);
  });

  it("recovers a generating restart without duplicating onboarding", async () => {
    const first = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await first.register(session, { emptyProject: true, mode: "created" });
    await first.onSessionStatus(session);
    await first.enqueue(session.id, "continue with my request");
    const greeting = submitted[0]!;

    const restarted = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });

    expect(submitted).toEqual([greeting, "continue with my request"]);
    expect(session.planning).toMatchObject({
      greeting: { status: "skipped", reason: "user-proceeded" },
      queuedInputIds: [],
    });
  });

  it("lets queued user work win an in-flight greeting failure", async () => {
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, { emptyProject: false, mode: "created" });
    await coordinator.onSessionStatus(session);
    const greeting = submitted[0]!;
    await coordinator.enqueue(session.id, "review the existing plan");
    coordinator.decorateLocalEvent(
      event(session.id, "prompt.submitted", { prompt: greeting }),
    );

    await coordinator.onEventPersisted(
      event(session.id, "turn.completed", { assistantText: null }),
    );

    expect(submitted).toEqual([greeting, "review the existing plan"]);
    expect(session.planning?.greeting).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
  });

  it("bounds retry to failed, retryable sessions without accepted user work", async () => {
    session.planning!.greeting = {
      status: "failed",
      retryable: true,
      errorCode: "model_turn_failed",
    };
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await coordinator.retry(session.id);
    expect(submitted).toHaveLength(1);
    expect(session.planning?.greeting.status).toBe("generating");
    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      PlannerGreetingRetryUnavailableError,
    );
  });

  it("keeps a same-process generating attempt live on idempotent registration", async () => {
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await coordinator.onSessionStatus(session);
    const generating = structuredClone(session.planning!.greeting);

    await coordinator.register(session, { emptyProject: true, mode: "live" });

    expect(session.planning?.greeting).toEqual(generating);
    expect(submitted).toHaveLength(1);
  });

  it("keeps resume-suppressed skipped state authoritative over a stale queue file", async () => {
    const first = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await first.register(session, { emptyProject: true, mode: "created" });
    await first.onSessionStatus(session);
    await first.enqueue(session.id, "continue from durable input");
    session.planning!.greeting = { status: "skipped", reason: "user-proceeded" };

    const resumed = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await resumed.register(session, { emptyProject: true, mode: "resumed" });

    expect(session.planning).toMatchObject({
      greeting: { status: "skipped", reason: "user-proceeded" },
      queuedInputIds: [],
    });
    expect(submitted.at(-1)).toBe("continue from durable input");
  });

  it("bounds pending readiness, then drains its durable FIFO when readiness arrives", async () => {
    vi.useFakeTimers();
    session.ready = false;
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 100,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await coordinator.enqueue(session.id, "queued while booting");
    await vi.advanceTimersByTimeAsync(101);
    await (coordinator as unknown as { writes: Map<string, Promise<unknown>> })
      .writes.get(session.id);
    expect(session.planning?.greeting).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
    expect(submitted).toEqual([]);

    session.ready = true;
    await coordinator.onSessionStatus(session);
    expect(submitted).toEqual(["queued while booting"]);
    expect(session.planning?.queuedInputIds).toEqual([]);
  });

  it("classifies an exit from pending and clears stale correlation state", async () => {
    session.ready = false;
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    session.status = "exited";
    await coordinator.onSessionStatus(session);

    expect(session.planning?.greeting).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "session_exited",
    });
    const decorated = coordinator.decorateLocalEvent(
      event(session.id, "prompt.submitted", {
        prompt: plannerGreetingPrompt(true),
      }),
    );
    expect(decorated.payload).not.toHaveProperty("plannerOrigin");
  });

  it("does not let an old attempt timeout fail a retry", async () => {
    vi.useFakeTimers();
    const ids = ["attempt-1", "attempt-2"];
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "state-write",
      deliveryTimeoutMs: 100,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await coordinator.onSessionStatus(session);
    const prompt = submitted[0]!;
    coordinator.decorateLocalEvent(
      event(session.id, "prompt.submitted", { prompt }),
    );
    await vi.advanceTimersByTimeAsync(50);
    await coordinator.onEventPersisted(
      event(session.id, "turn.completed", { assistantText: null }),
    );
    await coordinator.retry(session.id);

    await vi.advanceTimersByTimeAsync(51);
    expect(session.planning?.greeting).toEqual({
      status: "generating",
      attemptId: "attempt-2",
    });
  });

  it("adds expected correlation only after a submit is accepted", async () => {
    manager.submitInput = async () => false;
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await coordinator.onSessionStatus(session);
    const decorated = coordinator.decorateLocalEvent(
      event(session.id, "prompt.submitted", {
        prompt: plannerGreetingPrompt(true),
      }),
    );

    expect(decorated.payload).not.toHaveProperty("plannerOrigin");
    expect(session.planning?.greeting).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "session_exited",
    });
  });

  it("quarantines a corrupt queue without preventing local registration", async () => {
    const dir = path.join(root, session.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "input-queue.json"), "{secret-corrupt");
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });

    await expect(
      coordinator.register(session, { emptyProject: true, mode: "boot" }),
    ).resolves.toBeUndefined();
    const names = await fs.readdir(dir);
    expect(names).toContain("input-queue.json");
    expect(names.some((name) => name.startsWith("input-queue.corrupt-"))).toBe(true);
  });

  it("durably classifies queue persistence failure without raw error content", async () => {
    const events: unknown[] = [];
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      writeState: async () => {
        throw new Error("/private/path provider secret");
      },
      onEvent: (value) => {
        events.push(value);
      },
    });

    await expect(
      coordinator.register(session, { emptyProject: true, mode: "created" }),
    ).rejects.toThrow("planner state persistence failed");
    expect(session.planning?.greeting).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "persistence_failed",
    });
    expect(JSON.stringify(events)).not.toContain("private/path");
    expect(JSON.stringify(events)).not.toContain("provider secret");
  });

  it("emits bounded lifecycle codes without prompts, paths, or provider errors", async () => {
    const lifecycle: unknown[] = [];
    manager.submitInput = async () => {
      throw new Error("provider said /private/customer secret-token");
    };
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      onEvent: (value) => {
        lifecycle.push(value);
      },
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await coordinator.onSessionStatus(session);

    expect(lifecycle).toEqual([
      expect.objectContaining({
        name: "planner_greeting.attempted",
        projectId: "project-1",
        sessionId: session.id,
      }),
      expect.objectContaining({
        name: "planner_greeting.failed",
        errorCode: "injection_failed",
      }),
    ]);
    const serialized = JSON.stringify(lifecycle);
    expect(serialized).not.toContain("Agent Studio control turn");
    expect(serialized).not.toContain("/private/customer");
    expect(serialized).not.toContain("secret-token");
  });
});

describe("plannerGreetingPrompt", () => {
  it("keeps the automatic greeting scoped to collaborative planning and one question", () => {
    const empty = plannerGreetingPrompt(true);
    const existing = plannerGreetingPrompt(false);
    for (const prompt of [empty, existing]) {
      expect(prompt).toContain("project planning agent");
      expect(prompt).toContain("agents, responsibilities, data flow, resources, and connectors");
      expect(prompt).toContain("exactly one open-ended question");
      expect(prompt).toContain("Do not propose an architecture");
      expect(prompt).toContain("invoke tools");
    }
    expect(empty).toContain("what the system should accomplish");
    expect(existing).toContain("current plan exists");
  });
});
