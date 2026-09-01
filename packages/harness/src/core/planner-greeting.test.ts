import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists one ready-gated greeting, then releases accepted input FIFO", async () => {
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, true);
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
    await first.register(session, true);
    await first.onSessionStatus(session);
    await first.enqueue(session.id, "continue with my request");
    const greeting = submitted[0]!;

    const restarted = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await restarted.register(session, true);

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
    await coordinator.register(session, false);
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
    await coordinator.register(session, true);
    await coordinator.retry(session.id);
    expect(submitted).toHaveLength(1);
    expect(session.planning?.greeting.status).toBe("generating");
    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      PlannerGreetingRetryUnavailableError,
    );
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
