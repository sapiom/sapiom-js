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

  it("uses its accepted ledger to finish a failed dequeue after restart without duplicate or loss", async () => {
    session.planning!.greeting = {
      status: "delivered",
      messageId: "greeting-message",
    };
    let failAcceptedDequeue = true;
    const first = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
      writeState: async (file, value) => {
        const state = value as {
          dispatchingInputId: string | null;
          inputs: unknown[];
        };
        if (
          failAcceptedDequeue &&
          submitted.length === 1 &&
          state.dispatchingInputId === null &&
          state.inputs.length === 0
        ) {
          failAcceptedDequeue = false;
          throw new Error("injected queue cleanup failure");
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
      },
    });
    await first.register(session, { emptyProject: true, mode: "created" });

    await expect(
      first.enqueue(session.id, "deliver exactly once"),
    ).resolves.toBeDefined();
    expect(submitted).toEqual(["deliver exactly once"]);
    const durableBeforeRestart = JSON.parse(
      await fs.readFile(
        path.join(root, session.id, "input-queue.json"),
        "utf8",
      ),
    ) as { dispatchingInputId: string | null; inputs: Array<{ id: string }> };
    expect(durableBeforeRestart.dispatchingInputId).toBe(
      durableBeforeRestart.inputs[0]!.id,
    );
    const acceptedBeforeRestart = JSON.parse(
      await fs.readFile(
        path.join(root, session.id, "accepted-inputs.json"),
        "utf8",
      ),
    ) as { inputIds: string[] };
    expect(acceptedBeforeRestart.inputIds).toEqual([
      durableBeforeRestart.inputs[0]!.id,
    ]);

    const restarted = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });

    expect(submitted).toEqual(["deliver exactly once"]);
    expect(session.planning?.queuedInputIds).toEqual([]);
    const durableAfterRestart = JSON.parse(
      await fs.readFile(
        path.join(root, session.id, "input-queue.json"),
        "utf8",
      ),
    ) as { dispatchingInputId: string | null; inputs: unknown[] };
    expect(durableAfterRestart).toMatchObject({
      dispatchingInputId: null,
      inputs: [],
    });
  });

  it("resolves an orphaned dispatch as uncertain and lets the later FIFO continue", async () => {
    session.ready = false;
    session.planning!.greeting = {
      status: "delivered",
      messageId: "greeting-message",
    };
    let firstSubmitAttempted = false;
    let failRollback = true;
    manager.submitInput = async (_id: string, text: string) => {
      if (!firstSubmitAttempted) {
        firstSubmitAttempted = true;
        throw new Error("process ended before PTY acceptance was knowable");
      }
      submitted.push(text);
      return true;
    };
    const first = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      writeState: async (file, value) => {
        const state = value as {
          dispatchingInputId: string | null;
          inputs: unknown[];
        };
        if (
          failRollback &&
          firstSubmitAttempted &&
          state.dispatchingInputId === null &&
          state.inputs.length === 2
        ) {
          failRollback = false;
          throw new Error("simulated crash before intent rollback");
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
      },
    });
    await first.register(session, { emptyProject: true, mode: "created" });
    await first.enqueue(session.id, "delivery became uncertain");
    await first.enqueue(session.id, "must still make progress");
    session.ready = true;
    await first.onSessionStatus(session);

    const lifecycle: unknown[] = [];
    const restarted = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      onEvent: (value) => {
        lifecycle.push(value);
      },
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });

    expect(submitted).toEqual(["must still make progress"]);
    expect(session.planning?.queuedInputIds).toEqual([]);
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        name: "planner_session.input_delivery_uncertain",
        errorCode: "delivery_uncertain",
        queueDepth: 1,
      }),
    );
    expect(JSON.stringify(lifecycle)).not.toContain("delivery became uncertain");
  });

  it("compacts a stale accepted-ledger entry before acknowledging later input", async () => {
    session.planning!.greeting = {
      status: "delivered",
      messageId: "greeting-message",
    };
    let failFirstCleanup = true;
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      writeAcceptedLedger: async (file, value) => {
        const ledger = value as { inputIds: string[] };
        if (failFirstCleanup && ledger.inputIds.length === 0) {
          failFirstCleanup = false;
          throw new Error("injected accepted-ledger cleanup failure");
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
      },
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });

    await coordinator.enqueue(session.id, "first accepted input");
    await coordinator.enqueue(session.id, "second accepted input");

    expect(submitted).toEqual(["first accepted input", "second accepted input"]);
    expect(session.planning?.queuedInputIds).toEqual([]);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, session.id, "accepted-inputs.json"),
          "utf8",
        ),
      ),
    ).toEqual({ schemaVersion: 1, inputIds: [] });
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

  it("does not extend the readiness deadline on live re-registration", async () => {
    vi.useFakeTimers();
    session.ready = false;
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 100,
    });
    await coordinator.register(session, { emptyProject: true, mode: "created" });
    await vi.advanceTimersByTimeAsync(60);
    await coordinator.register(session, { emptyProject: true, mode: "live" });
    await vi.advanceTimersByTimeAsync(41);
    await (coordinator as unknown as { writes: Map<string, Promise<unknown>> })
      .writes.get(session.id);

    expect(session.planning?.greeting).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "session_not_ready",
    });
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

  it("removes timed-out correlation so one retry completion delivers the greeting", async () => {
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
    await vi.advanceTimersByTimeAsync(101);
    await (coordinator as unknown as { writes: Map<string, Promise<unknown>> })
      .writes.get(session.id);
    expect(session.planning?.greeting).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "delivery_timeout",
    });

    await coordinator.retry(session.id);
    const retryPrompt = submitted[1]!;
    const retryEvent = coordinator.decorateLocalEvent(
      event(session.id, "prompt.submitted", { prompt: retryPrompt }),
    );
    expect(retryEvent.payload.plannerAttemptId).toBe("attempt-2");
    await coordinator.onEventPersisted(
      event(session.id, "turn.completed", {
        assistantText: "What kind of agent architecture should we build?",
      }),
    );

    expect(session.planning?.greeting).toEqual({
      status: "delivered",
      messageId: "event-turn.completed",
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
    session.planning!.queuedInputIds = ["stale-registry-input"];
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
    expect(session.planning?.queuedInputIds).toEqual([]);
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
