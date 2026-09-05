import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectAgentSession,
  ProjectBootstrapLifecycleEvent,
  ProjectBootstrapMetadata,
  ProjectBootstrapState,
} from "../shared/agent-map.js";
import type { AnalyticsEvent, HarnessSession } from "../shared/types.js";
import type { SessionManager } from "./session-manager.js";
import {
  SessionBackgroundInputPreemptedError,
  SessionInputGuardRejectedError,
  SessionNotReadyError,
  type SessionInputWriteLifecycle,
  type TerminalInputContext,
} from "./session-manager.js";
import {
  ProjectBootstrapCoordinator as ProjectBootstrapCoordinatorImpl,
  ProjectBootstrapCoordinatorClosedError,
  ProjectBootstrapDispatchForbiddenError,
  ProjectBootstrapInputCapacityError,
  ProjectBootstrapRequestIdConflictError,
  ProjectBootstrapRetryUnavailableError,
  projectBootstrapPrompt,
  type ProjectBootstrapCoordinatorOptions,
} from "./project-bootstrap.js";

const activeCoordinators = new Set<ProjectBootstrapCoordinatorImpl>();
const TEST_RUNTIME_EPOCH = "runtime-epoch-test";

class ProjectBootstrapCoordinator extends ProjectBootstrapCoordinatorImpl {
  constructor(options: ProjectBootstrapCoordinatorOptions) {
    super(options);
    activeCoordinators.add(this);
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      activeCoordinators.delete(this);
    }
  }

  override async register(
    session: HarnessSession,
    context: Parameters<ProjectBootstrapCoordinatorImpl["register"]>[1],
    runtimeEpoch: string | null = TEST_RUNTIME_EPOCH,
  ): Promise<void> {
    if (runtimeEpoch !== null) {
      await super.transitionRuntimeEpoch(session, runtimeEpoch);
    }
    return super.register(session, context, runtimeEpoch);
  }

  override onSessionStatus(
    session: HarnessSession,
    runtimeEpoch: string | null = TEST_RUNTIME_EPOCH,
  ): Promise<void> {
    return super.onSessionStatus(session, runtimeEpoch);
  }

  override decorateLocalEvent(
    event: AnalyticsEvent,
    runtimeEpoch = TEST_RUNTIME_EPOCH,
  ): AnalyticsEvent {
    return super.decorateLocalEvent(event, runtimeEpoch);
  }

  override onEventPersisted(
    event: AnalyticsEvent,
    runtimeEpoch = TEST_RUNTIME_EPOCH,
  ): Promise<void> {
    return super.onEventPersisted(event, runtimeEpoch);
  }

  override onTerminalInput(
    sessionId: string,
    context: Partial<TerminalInputContext> = {},
  ): void {
    // Production admits the epoch before publishing the PTY. A few unit tests
    // intentionally exercise raw input before register(), so mirror that
    // already-completed SessionManager transition in the test adapter.
    const runtimeEpoch = context.runtimeEpoch ?? TEST_RUNTIME_EPOCH;
    const epochs = (
      this as unknown as { runtimeEpochs: Map<string, string> }
    ).runtimeEpochs;
    if (!epochs.has(sessionId)) epochs.set(sessionId, runtimeEpoch);
    super.onTerminalInput(sessionId, {
      runtimeEpoch,
      blockingPrompt: context.blockingPrompt ?? false,
    });
  }
}

const PROJECT_ID = "project_00000000-0000-7000-8000-000000000001";
const USER_ID = "user-1";
const NOW = "2026-09-01T00:00:00.000Z";

interface SubmittedInput {
  sessionId: string;
  text: string;
  submit: boolean | undefined;
  background: boolean | undefined;
}

interface DurableBootstrapState {
  schemaVersion: number;
  metadata: ProjectBootstrapMetadata;
  inputs: Array<{
    id: string;
    sessionId: string;
    text: string;
    acceptedAt: string;
  }>;
  dispatchingInputId: string | null;
  retryCount: number;
  emptyProject: boolean;
  attempts: Array<{
    attemptId: string;
    retryOrdinal: number;
    status: "active" | "retired" | "completed";
    phase?: "claimed" | "dispatching" | "not-submitted" | "submitted";
  }>;
  uncertainInputIds?: string[];
  uncertainInputs?: Array<{
    id: string;
    sessionId: string;
    text: string;
    acceptedAt: string;
  }>;
  receipts?: Array<{
    requestId: string | null;
    inputId: string;
    status: "queued" | "submitted" | "uncertain" | "completed";
    acceptedAt: string;
    payloadDigest: string;
  }>;
}

function analyticsEvent(
  sessionId: string,
  type: AnalyticsEvent["type"],
  payload: Record<string, unknown>,
  eventId = `event-${type}`,
): AnalyticsEvent {
  return {
    eventId,
    seq: 1,
    ts: NOW,
    userId: USER_ID,
    tenantId: null,
    machineId: "machine-1",
    harnessSessionId: sessionId,
    agentSessionId: "provider-conversation-1",
    harness: "codex",
    type,
    payload,
  };
}

function projectBootstrapInputDigestForTest(text: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, submit: true, text }))
    .digest("hex");
}

function projectSession(
  id = "session-1",
  bootstrap: ProjectBootstrapState = { status: "pending" },
): HarnessSession {
  const identity: ProjectAgentSession = {
    projectId: PROJECT_ID,
    sessionId: id,
    userId: USER_ID,
  };
  return {
    id,
    agentSessionId: "provider-conversation-1",
    harness: "codex",
    cwd: "/private/project",
    title: "Plan Agents",
    status: "running",
    createdAt: NOW,
    lastActiveAt: NOW,
    exitCode: null,
    boundWorkflowPath: null,
    ready: true,
    agentMapIdentity: identity,
    projectBootstrap: {
      projectId: identity.projectId,
      userId: identity.userId,
      targetSessionId: identity.sessionId,
      bootstrap: structuredClone(bootstrap),
      queuedInputIds: [],
    },
  };
}

function stateFile(root: string, sessionId: string): string {
  return path.join(root, sessionId, "input-queue.json");
}

async function readState(
  root: string,
  sessionId: string,
): Promise<DurableBootstrapState> {
  return JSON.parse(
    await fs.readFile(stateFile(root, sessionId), "utf8"),
  ) as DurableBootstrapState;
}

async function writeState(
  root: string,
  sessionId: string,
  state: DurableBootstrapState,
): Promise<void> {
  await fs.mkdir(path.dirname(stateFile(root, sessionId)), { recursive: true });
  await fs.writeFile(stateFile(root, sessionId), `${JSON.stringify(state)}\n`);
}

async function flushCoordinator(
  coordinator: ProjectBootstrapCoordinator,
  key: string,
): Promise<void> {
  const writes = (
    coordinator as unknown as { writes: Map<string, Promise<unknown>> }
  ).writes;
  const pending = writes.get(key);
  if (pending) await pending.catch(() => {});
  await Promise.resolve();
}

describe("ProjectBootstrapCoordinator", () => {
  let root: string;
  let legacyRoot: string;
  let session: HarnessSession;
  let sessions: Map<string, HarnessSession>;
  let submitted: SubmittedInput[];
  let manager: SessionManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "project-bootstrap-"));
    legacyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "planner-greeting-legacy-"),
    );
    session = projectSession();
    sessions = new Map([[session.id, session]]);
    submitted = [];
    manager = {
      get: (id: string) => sessions.get(id),
      setProjectBootstrapMetadata: async (
        id: string,
        metadata: ProjectBootstrapMetadata,
      ) => {
        const target = sessions.get(id);
        if (!target) throw new Error("session missing");
        target.projectBootstrap = structuredClone(metadata);
      },
      submitInput: async (
        id: string,
        text: string,
        submit?: boolean,
        canWrite?: () => boolean | Promise<boolean>,
        background?: boolean,
        lifecycle?: SessionInputWriteLifecycle,
      ) => {
        if (canWrite && !(await canWrite())) return false;
        await lifecycle?.beforeFirstWrite?.();
        if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
        submitted.push({ sessionId: id, text, submit, background });
        return true;
      },
      preemptBackgroundInput: () => false,
      getRuntimeEpoch: (id: string) =>
        sessions.get(id)?.status === "running" ? TEST_RUNTIME_EPOCH : null,
    } as unknown as SessionManager;
  });

  afterEach(async () => {
    await Promise.all(
      [...activeCoordinators].map((coordinator) => coordinator.close()),
    );
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(legacyRoot, { recursive: true, force: true });
  });

  it("keeps pending readiness and model-turn deadlines distinct", async () => {
    vi.useFakeTimers();
    session.ready = false;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      readinessTimeoutMs: 100,
      deliveryTimeoutMs: 1_000,
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await vi.advanceTimersByTimeAsync(60);
    await coordinator.register(session, { emptyProject: true, mode: "live" });
    await vi.advanceTimersByTimeAsync(41);
    await flushCoordinator(coordinator, session.id);

    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "session_not_ready",
    });
    expect(submitted).toEqual([]);

    session = projectSession("session-turn-timeout");
    sessions.set(session.id, session);
    const turnCoordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      readinessTimeoutMs: 50,
      deliveryTimeoutMs: 200,
      generateId: () => "attempt-turn-timeout",
    });
    await turnCoordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await vi.advanceTimersByTimeAsync(51);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "generating",
      attemptId: "attempt-turn-timeout",
    });
    await vi.advanceTimersByTimeAsync(150);
    await flushCoordinator(turnCoordinator, session.id);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "delivery_timeout",
    });
  });

  it("rechecks durable map content and skips a no-longer-empty project without a model turn", async () => {
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      isMeaningfullyEmpty: async (projectId) => {
        expect(projectId).toBe(PROJECT_ID);
        return false;
      },
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });

    expect(submitted).toEqual([]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "map-not-empty",
    });
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        name: "project_bootstrap.skipped",
        reason: "map-not-empty",
        queueDepth: 0,
      }),
    );
    expect((await readState(root, session.id)).emptyProject).toBe(false);
  });

  it("correlates one unique evidence-first bootstrap and ignores duplicate readiness and completion signals", async () => {
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-unique-1",
      deliveryTimeoutMs: 60_000,
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await coordinator.register(session, { emptyProject: true, mode: "live" });
    await coordinator.onSessionStatus(session);
    await coordinator.onSessionStatus(session);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      sessionId: session.id,
      submit: true,
      background: true,
    });
    expect(submitted[0]!.text).toContain("attempt-unique-1");

    const local = coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: submitted[0]!.text,
      }),
    );
    expect(local.payload).toMatchObject({
      projectBootstrapOrigin: "infrastructure",
      projectBootstrapAttemptId: "attempt-unique-1",
    });

    await coordinator.onEventPersisted(
      analyticsEvent(
        session.id,
        "turn.completed",
        { assistantText: "Evidence-supported map seed complete." },
        "turn-bootstrap-1",
      ),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(
        session.id,
        "turn.completed",
        { assistantText: "Duplicate completion." },
        "turn-bootstrap-duplicate",
      ),
    );

    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "delivered",
      messageId: "turn-bootstrap-1",
    });
    expect(
      lifecycle.filter((event) => event.name === "project_bootstrap.attempted"),
    ).toHaveLength(1);
    expect(
      lifecycle.filter((event) => event.name === "project_bootstrap.delivered"),
    ).toHaveLength(1);
  });

  it("retains attempt tombstones so a late timed-out turn cannot complete its retry", async () => {
    vi.useFakeTimers();
    const ids = ["attempt-1", "attempt-2"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    const firstPrompt = submitted[0]!.text;
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", { prompt: firstPrompt }),
    );
    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "delivery_timeout",
    });

    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapRetryUnavailableError,
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "Late output from attempt one.",
      }),
    );
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "delivery_timeout",
    });

    await coordinator.retry(session.id);
    const retryPrompt = submitted[1]!.text;
    expect(retryPrompt).not.toBe(firstPrompt);
    expect(retryPrompt).toContain("automatic retry 1 of 2");
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", { prompt: retryPrompt }),
    );

    await coordinator.onEventPersisted(
      analyticsEvent(
        session.id,
        "turn.completed",
        { assistantText: "Retry map seed complete." },
        "turn-retry",
      ),
    );
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "delivered",
      messageId: "turn-retry",
    });
    const durable = await readState(root, session.id);
    expect(durable.retryCount).toBe(1);
    expect(durable.attempts).toEqual([
      {
        attemptId: "attempt-1",
        retryOrdinal: 0,
        status: "retired",
        phase: "submitted",
      },
      {
        attemptId: "attempt-2",
        retryOrdinal: 1,
        status: "completed",
        phase: "submitted",
      },
    ]);
    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapRetryUnavailableError,
    );
  });

  it("releases input after a bounded timed-out turn and never replays it after restart", async () => {
    vi.useFakeTimers();
    const ids = ["attempt-before-process-restart", "input-after-restart"];
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
    });
    await first.register(session, { emptyProject: true, mode: "created" });
    const bootstrapPrompt = submitted[0]!.text;
    first.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: bootstrapPrompt,
      }),
    );

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(first, session.id);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "delivery_timeout",
    });

    await expect(
      first.enqueue(session.id, "implement the durable request directly"),
    ).resolves.toMatchObject({ queuedInputIds: [] });
    expect(submitted.map((entry) => entry.text)).toEqual([
      bootstrapPrompt,
      "implement the durable request directly",
    ]);

    // Restart must not re-submit either already accepted turn.
    session.status = "exited";
    session.ready = false;
    await first.onSessionStatus(session);
    await first.close();
    session.status = "running";
    session.ready = true;
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });
    await restarted.register(session, { emptyProject: true, mode: "live" });
    await restarted.onSessionStatus(session);

    expect(submitted.map((entry) => entry.text)).toEqual([
      bootstrapPrompt,
      "implement the durable request directly",
    ]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
    expect(session.projectBootstrap?.queuedInputIds).toEqual([]);
    expect((await readState(root, session.id)).inputs).toEqual([]);
  });

  it("recovers an ambiguous generating restart as a non-retryable tombstone without blindly submitting again", async () => {
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-before-restart",
      deliveryTimeoutMs: 60_000,
    });
    await first.register(session, { emptyProject: true, mode: "created" });
    expect(submitted).toHaveLength(1);
    expect(session.projectBootstrap?.bootstrap.status).toBe("generating");

    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });

    expect(submitted).toHaveLength(1);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "delivery_timeout",
    });
    await expect(restarted.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapRetryUnavailableError,
    );
    expect((await readState(root, session.id)).attempts).toEqual([
      {
        attemptId: "attempt-before-restart",
        retryOrdinal: 0,
        status: "retired",
        phase: "submitted",
      },
    ]);
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        name: "project_bootstrap.recovered",
        sessionId: session.id,
      }),
    );
  });

  it.each(["claimed", "not-submitted"] as const)(
    "publishes the committed retryable recovery for a %s attempt restored without a ready runtime",
    async (phase) => {
      session.ready = false;
      session.status = "exited";
      session.projectBootstrap!.bootstrap = {
        status: "generating",
        attemptId: "attempt-unsubmitted-before-crash",
      };
      await writeState(root, session.id, {
        schemaVersion: 3,
        metadata: structuredClone(session.projectBootstrap!),
        inputs: [],
        dispatchingInputId: null,
        retryCount: 0,
        emptyProject: true,
        attempts: [
          {
            attemptId: "attempt-unsubmitted-before-crash",
            retryOrdinal: 0,
            status: "active",
            phase,
          },
        ],
        receipts: [],
      });
      const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
      const eventsBeforeCommit: ProjectBootstrapLifecycleEvent[][] = [];
      const coordinator = new ProjectBootstrapCoordinator({
        root,
        sessionManager: manager,
        onEvent: (event) => { lifecycle.push(event); },
        writeState: async (file, state) => {
          eventsBeforeCommit.push([...lifecycle]);
          await fs.writeFile(file, JSON.stringify(state));
        },
      });

      await coordinator.register(
        session, { emptyProject: true, mode: "boot" }, null,
      );

      expect(session.projectBootstrap!.bootstrap).toEqual({
        status: "failed",
        retryable: true,
        errorCode: "injection_failed",
      });
      expect((await readState(root, session.id)).metadata.bootstrap).toEqual(
        session.projectBootstrap!.bootstrap,
      );
      expect(
        lifecycle.filter((event) => event.name === "project_bootstrap.failed"),
      ).toEqual([
        {
          name: "project_bootstrap.failed",
          projectId: PROJECT_ID,
          sessionId: session.id,
          attemptId: "attempt-unsubmitted-before-crash",
          errorCode: "injection_failed",
          retryable: true,
          queueDepth: 0,
        },
      ]);
      expect(eventsBeforeCommit).toEqual([[]]);
      expect(submitted).toEqual([]);
    },
  );

  it("publishes only the committed persistence failure when boot recovery cannot persist its classification", async () => {
    session.ready = false;
    session.status = "exited";
    session.projectBootstrap!.bootstrap = {
      status: "generating",
      attemptId: "attempt-before-storage-failure",
    };
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs: [],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: true,
      attempts: [
        {
          attemptId: "attempt-before-storage-failure",
          retryOrdinal: 0,
          status: "active",
          phase: "claimed",
        },
      ],
      receipts: [],
    });
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      onEvent: (event) => { lifecycle.push(event); },
      writeState: vi.fn(async (file, state) => {
        await fs.writeFile(file, JSON.stringify(state));
      }).mockRejectedValueOnce(new Error("storage unavailable")),
    });

    await expect(coordinator.register(
      session, { emptyProject: true, mode: "boot" }, null,
    )).rejects.toThrow("project bootstrap state persistence failed");

    expect((await readState(root, session.id)).metadata.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "persistence_failed",
    });
    expect(lifecycle).toEqual([
      {
        name: "project_bootstrap.failed",
        projectId: PROJECT_ID,
        sessionId: session.id,
        errorCode: "persistence_failed",
        retryable: true,
        queueDepth: 0,
      },
    ]);
    expect(submitted).toEqual([]);
  });

  it("retries exactly once after restart when the durable attempt never reached its pre-write marker", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "generating",
      attemptId: "attempt-claimed-before-crash",
    };
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs: [],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: true,
      attempts: [
        {
          attemptId: "attempt-claimed-before-crash",
          retryOrdinal: 0,
          status: "active",
          phase: "claimed",
        },
      ],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: [],
    });

    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-recovered-once",
      deliveryTimeoutMs: 60_000,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toContain("attempt-recovered-once");
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "generating",
      attemptId: "attempt-recovered-once",
    });
    expect((await readState(root, session.id)).attempts).toEqual([
      {
        attemptId: "attempt-claimed-before-crash",
        retryOrdinal: 0,
        status: "retired",
        phase: "claimed",
      },
      {
        attemptId: "attempt-recovered-once",
        retryOrdinal: 1,
        status: "active",
        phase: "submitted",
      },
    ]);

    await restarted.register(session, { emptyProject: true, mode: "live" });
    expect(submitted).toHaveLength(1);
  });

  it("never replays a generating attempt whose pre-write dispatch marker is durable", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "generating",
      attemptId: "attempt-dispatch-uncertain",
    };
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs: [],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: true,
      attempts: [
        {
          attemptId: "attempt-dispatch-uncertain",
          retryOrdinal: 0,
          status: "active",
          phase: "dispatching",
        },
      ],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: [],
    });

    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });

    expect(submitted).toEqual([]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "delivery_timeout",
    });
    expect((await readState(root, session.id)).attempts[0]).toMatchObject({
      attemptId: "attempt-dispatch-uncertain",
      status: "retired",
      phase: "dispatching",
    });
  });

  it("never replays a schema-3 bootstrap attempt already submitted before restart", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "generating",
      attemptId: "attempt-submitted-before-restart",
    };
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs: [],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: true,
      attempts: [
        {
          attemptId: "attempt-submitted-before-restart",
          retryOrdinal: 0,
          status: "active",
          phase: "submitted",
        },
      ],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: [],
    });

    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });

    expect(submitted).toEqual([]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "delivery_timeout",
    });
    expect((await readState(root, session.id)).attempts[0]).toMatchObject({
      attemptId: "attempt-submitted-before-restart",
      status: "retired",
      phase: "submitted",
    });
    await expect(restarted.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapRetryUnavailableError,
    );
  });

  it("keeps a post-Enter bootstrap state-write failure bounded before admitting user input", async () => {
    vi.useFakeTimers();
    const ids = ["attempt-post-enter-write-failure", "input-after-bootstrap"];
    let failedSubmittedWrite = false;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
      writeState: async (_file, value) => {
        const durable = value as DurableBootstrapState;
        if (
          !failedSubmittedWrite &&
          durable.metadata.bootstrap.status === "generating" &&
          durable.attempts.some(
            (attempt) =>
              attempt.attemptId === "attempt-post-enter-write-failure" &&
              attempt.phase === "submitted",
          )
        ) {
          failedSubmittedWrite = true;
          throw new Error("injected submitted bootstrap state failure");
        }
        await writeState(root, session.id, durable);
      },
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    const bootstrapPrompt = submitted[0]!.text;
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: bootstrapPrompt,
      }),
    );
    const queued = await coordinator.enqueueWithReceipt(
      session.id,
      "build after the failed bootstrap state write",
      "request-after-bootstrap-state-failure",
    );

    expect(failedSubmittedWrite).toBe(true);
    expect(queued.receipt.status).toBe("queued");
    expect(submitted.map((entry) => entry.text)).toEqual([bootstrapPrompt]);

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    expect(submitted.map((entry) => entry.text)).toEqual([
      bootstrapPrompt,
      "build after the failed bootstrap state write",
    ]);
    expect((await readState(root, session.id)).receipts).toContainEqual(
      expect.objectContaining({
        inputId: "input-after-bootstrap",
        status: "submitted",
      }),
    );

    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "late bootstrap completion",
      }),
    );
    expect(coordinator.ownsInput(session.id)).toBe(true);
    expect(submitted).toHaveLength(2);
  });

  it("refuses to retry a submitted bootstrap after its durable state write fails", async () => {
    vi.useFakeTimers();
    let failedSubmittedWrite = false;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-submitted-write-failure",
      deliveryTimeoutMs: 100,
      writeState: async (_file, value) => {
        const durable = value as DurableBootstrapState;
        if (
          !failedSubmittedWrite &&
          durable.metadata.bootstrap.status === "generating" &&
          durable.attempts.some(
            (attempt) =>
              attempt.attemptId === "attempt-submitted-write-failure" &&
              attempt.phase === "submitted",
          )
        ) {
          failedSubmittedWrite = true;
          throw new Error("injected submitted bootstrap state failure");
        }
        await writeState(root, session.id, durable);
      },
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "persistence_failed",
    });
    expect(submitted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapRetryUnavailableError,
    );
    expect(submitted).toHaveLength(1);
    expect((await readState(root, session.id)).attempts.at(-1)).toMatchObject({
      attemptId: "attempt-submitted-write-failure",
      status: "retired",
      phase: "submitted",
    });
  });

  it("migrates a planner-era schema-1 FIFO in place without quarantine or input loss", async () => {
    session.ready = false;
    const legacyDirectory = path.join(legacyRoot, session.id);
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(
      path.join(legacyDirectory, "input-queue.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        metadata: {
          identity: {
            projectId: PROJECT_ID,
            userId: USER_ID,
            sessionId: session.id,
            role: "map-planner",
          },
          greeting: { status: "delivered", messageId: "legacy-greeting" },
          queuedInputIds: ["legacy-input-1", "legacy-input-2"],
        },
        inputs: [
          {
            id: "legacy-input-1",
            sessionId: session.id,
            text: "first durable user request",
            acceptedAt: NOW,
          },
          {
            id: "legacy-input-2",
            sessionId: session.id,
            text: "second durable user request",
            acceptedAt: NOW,
          },
        ],
        dispatchingInputId: null,
        retryCount: 0,
        emptyProject: true,
        // Schema 1 never defined this field. Migration must ignore it rather
        // than accepting forged keyed receipt authority.
        receipts: [
          {
            requestId: "forged-legacy-key",
            inputId: "legacy-input-1",
            status: "queued",
            acceptedAt: NOW,
            payloadDigest: "f".repeat(64),
          },
        ],
      })}\n`,
    );

    const coordinator = new ProjectBootstrapCoordinator({
      root,
      legacyStateRoot: legacyRoot,
      sessionManager: manager,
    });
    await coordinator.register(session, { emptyProject: true, mode: "boot" });

    const migrated = await readState(root, session.id);
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      metadata: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        targetSessionId: session.id,
        bootstrap: { status: "delivered", messageId: "legacy-greeting" },
        queuedInputIds: ["legacy-input-1", "legacy-input-2"],
      },
    });
    expect(migrated.metadata).not.toHaveProperty("identity");
    expect(migrated.metadata).not.toHaveProperty("greeting");
    expect(migrated.receipts).toHaveLength(2);
    expect(migrated.receipts?.map((receipt) => receipt.requestId)).toEqual([
      null,
      null,
    ]);
    expect(
      new Set(migrated.receipts?.map((receipt) => receipt.inputId)).size,
    ).toBe(2);
    expect(await fs.readdir(legacyDirectory)).toEqual(["input-queue.json"]);

    session.ready = true;
    await coordinator.onSessionStatus(session);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first durable user request",
    ]);
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "first durable user request",
      }),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "First request complete.",
      }),
    );
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first durable user request",
      "second durable user request",
    ]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual([]);
    expect((await readState(root, session.id)).inputs).toEqual([]);
  });

  it("lets API input preempt a pending bootstrap and preserves its FIFO order", async () => {
    session.ready = false;
    const ids = ["input-1", "input-2"];
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });

    await coordinator.enqueue(session.id, "first user request");
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
    expect(submitted).toEqual([]);

    session.ready = true;
    await coordinator.onSessionStatus(session);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first user request",
    ]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual([]);
    expect(coordinator.ownsInput(session.id)).toBe(true);

    await coordinator.enqueue(session.id, "second user request");
    await coordinator.onSessionStatus(session);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first user request",
    ]);
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "first user request",
      }),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "First request complete.",
      }),
    );
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first user request",
      "second user request",
    ]);
    expect(submitted.every((entry) => entry.background !== true)).toBe(true);
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        name: "project_bootstrap.preempted",
        reason: "user-proceeded",
        queueDepth: 1,
      }),
    );
  });

  it("durably prioritizes API input that arrives between background text and Enter", async () => {
    let announceStaged!: () => void;
    const staged = new Promise<void>((resolve) => {
      announceStaged = resolve;
    });
    let releaseStaged!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseStaged = resolve;
    });
    manager.preemptBackgroundInput = () => {
      releaseStaged();
      return true;
    };
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (background) {
        await lifecycle?.beforeFirstWrite?.();
        announceStaged();
        await released;
        if (canWrite && !(await canWrite())) {
          await lifecycle?.onNotSubmitted?.();
          throw new SessionInputGuardRejectedError(true);
        }
      }
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const ids = ["attempt-staged", "input-priority"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });

    const registering = coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await staged;
    const enqueueing = coordinator.enqueue(
      session.id,
      "implement the requested change now",
    );
    await Promise.all([registering, enqueueing]);

    expect(submitted).toEqual([
      {
        sessionId: session.id,
        text: "implement the requested change now",
        submit: true,
        background: false,
      },
    ]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
    expect((await readState(root, session.id)).attempts).toEqual([
      {
        attemptId: "attempt-staged",
        retryOrdinal: 0,
        status: "retired",
        phase: "not-submitted",
      },
    ]);
  });

  it("tombstones an in-flight bootstrap when durable API input arrives", async () => {
    const ids = ["attempt-1", "input-1"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    const bootstrapPrompt = submitted[0]!.text;
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: bootstrapPrompt,
      }),
    );

    await coordinator.enqueue(session.id, "build this directly now");
    expect(submitted.map((entry) => entry.text)).toEqual([bootstrapPrompt]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual(["input-1"]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });

    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "Late bootstrap output.",
      }),
    );
    expect(submitted.map((entry) => entry.text)).toEqual([
      bootstrapPrompt,
      "build this directly now",
    ]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
  });

  it("keeps durable API input queued through raw preemption and resumes it after the user turn", async () => {
    session.ready = false;
    let preemptOnce = true;
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (preemptOnce) {
        preemptOnce = false;
        coordinator.onTerminalInput(id);
        await lifecycle?.onNotSubmitted?.();
        throw new SessionBackgroundInputPreemptedError(true);
      }
      if (canWrite && !(await canWrite())) return false;
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-after-raw-turn",
    });
    manager.setProjectBootstrapMetadata = async (
      id: string,
      metadata: ProjectBootstrapMetadata,
    ) => {
      const target = sessions.get(id);
      if (!target) throw new Error("session missing");
      target.projectBootstrap = structuredClone(metadata);
      // Match production SessionManager: every durable projection emits a
      // re-entrant status callback. The coordinator must keep the raw turn's
      // ownership even when this callback is queued during persistence.
      void coordinator.onSessionStatus(target);
    };
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await coordinator.enqueue(session.id, "durable API request");

    session.ready = true;
    await coordinator.onSessionStatus(session);
    expect(submitted).toEqual([]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual([
      "input-after-raw-turn",
    ]);
    expect((await readState(root, session.id)).dispatchingInputId).toBeNull();
    await flushCoordinator(coordinator, session.id);
    expect(submitted).toEqual([]);

    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "raw terminal request",
      }),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "The user's raw terminal turn completed.",
      }),
    );
    expect(submitted.map((entry) => entry.text)).toEqual([
      "durable API request",
    ]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual([]);
  });

  it("raw terminal input synchronously preempts bootstrap before or during dispatch", async () => {
    const beforeRegistration = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    beforeRegistration.onTerminalInput(session.id);
    await beforeRegistration.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(submitted).toEqual([]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });

    session = projectSession("session-raw-in-flight");
    sessions.set(session.id, session);
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const inFlight = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-raw",
      deliveryTimeoutMs: 60_000,
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });
    await inFlight.register(session, { emptyProject: true, mode: "created" });
    expect(submitted).toHaveLength(1);
    inFlight.onTerminalInput(session.id);
    inFlight.onTerminalInput(session.id);
    await flushCoordinator(inFlight, session.id);

    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
    expect(
      lifecycle.filter((event) => event.name === "project_bootstrap.preempted"),
    ).toHaveLength(1);
  });

  it("tombstones an orphaned dispatch without replay and lets the later FIFO progress", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-turn",
    };
    await writeState(root, session.id, {
      schemaVersion: 2,
      metadata: {
        ...structuredClone(session.projectBootstrap!),
        queuedInputIds: ["input-uncertain", "input-safe-next"],
      },
      inputs: [
        {
          id: "input-uncertain",
          sessionId: session.id,
          text: "possibly accepted already",
          acceptedAt: NOW,
        },
        {
          id: "input-safe-next",
          sessionId: session.id,
          text: "definitely send next",
          acceptedAt: NOW,
        },
      ],
      dispatchingInputId: "input-uncertain",
      retryCount: 0,
      emptyProject: true,
      attempts: [],
    });
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });

    await restarted.register(session, { emptyProject: true, mode: "boot" });
    await restarted.register(session, { emptyProject: true, mode: "live" });

    expect(submitted.map((entry) => entry.text)).toEqual([
      "definitely send next",
    ]);
    expect(lifecycle).toContainEqual({
      name: "project_bootstrap.input_delivery_uncertain",
      projectId: PROJECT_ID,
      sessionId: session.id,
      inputId: "input-uncertain",
      errorCode: "delivery_uncertain",
      queueDepth: 2,
    });
    expect(JSON.stringify(lifecycle)).not.toContain(
      "possibly accepted already",
    );
    const persisted = await readState(root, session.id);
    expect(persisted.inputs).toEqual([]);
    expect(persisted.uncertainInputIds).toEqual(["input-uncertain"]);
    expect(persisted.uncertainInputs).toEqual([
      expect.objectContaining({
        id: "input-uncertain",
        text: "possibly accepted already",
      }),
    ]);
    expect(
      lifecycle.filter(
        (event) => event.name === "project_bootstrap.input_delivery_uncertain",
      ),
    ).toHaveLength(1);
  });

  it("classifies false dispatch, provider rejection, empty model output, and session exit", async () => {
    manager.submitInput = async () => false;
    const falseDispatch = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await falseDispatch.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "scope_unavailable",
    });

    session = projectSession("session-injection-failure");
    sessions.set(session.id, session);
    manager.submitInput = async (
      _id,
      _text,
      _submit,
      _canWrite,
      _background,
      lifecycle,
    ) => {
      await lifecycle?.beforeFirstWrite?.();
      await lifecycle?.onNotSubmitted?.();
      throw new Error("raw provider failure");
    };
    const injectionFailure = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await injectionFailure.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "injection_failed",
    });

    session = projectSession("session-empty-turn");
    sessions.set(session.id, session);
    submitted = [];
    manager.submitInput = async (id: string, text: string) => {
      submitted.push({ sessionId: id, text, submit: true, background: true });
      return true;
    };
    const emptyTurn = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-empty-turn",
      deliveryTimeoutMs: 60_000,
    });
    await emptyTurn.register(session, { emptyProject: true, mode: "created" });
    emptyTurn.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: submitted[0]!.text,
      }),
    );
    await emptyTurn.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", { assistantText: "   " }),
    );
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "model_turn_failed",
    });

    session = projectSession("session-exited-pending");
    session.ready = false;
    sessions.set(session.id, session);
    const exited = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      readinessTimeoutMs: 60_000,
    });
    await exited.register(session, { emptyProject: true, mode: "created" });
    session.status = "exited";
    await exited.onSessionStatus(session);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "session_exited",
    });

    session = projectSession("session-already-exited");
    session.ready = false;
    session.status = "exited";
    sessions.set(session.id, session);
    const alreadyExited = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      readinessTimeoutMs: 60_000,
    });
    await alreadyExited.register(session, {
      emptyProject: true,
      mode: "boot",
    });
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "session_exited",
    });
    expect(
      (alreadyExited as unknown as { timers: Map<string, unknown> }).timers
        .size,
    ).toBe(0);
  });

  it("allows one explicit retry after SessionNotReadyError proves Enter did not cross", async () => {
    const ids = ["attempt-not-ready", "attempt-ready-retry"];
    let submitCalls = 0;
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      submitCalls += 1;
      if (submitCalls === 1) throw new SessionNotReadyError(id);
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "session_not_ready",
    });
    expect((await readState(root, session.id)).attempts.at(-1)).toMatchObject({
      attemptId: "attempt-not-ready",
      status: "retired",
      phase: "claimed",
    });

    await coordinator.retry(session.id);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toContain("attempt-ready-retry");
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "generating",
      attemptId: "attempt-ready-retry",
    });
  });

  it("allows one explicit retry after a pre-Enter provider rejection", async () => {
    const ids = ["attempt-provider-rejected", "attempt-provider-retry"];
    let submitCalls = 0;
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      submitCalls += 1;
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (submitCalls === 1) {
        await lifecycle?.onNotSubmitted?.();
        throw new Error("provider rejected before the first PTY byte");
      }
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "injection_failed",
    });
    expect((await readState(root, session.id)).attempts.at(-1)).toMatchObject({
      attemptId: "attempt-provider-rejected",
      status: "retired",
      phase: "not-submitted",
    });

    await coordinator.close();
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });
    await restarted.retry(session.id);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toContain("attempt-provider-retry");
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "generating",
      attemptId: "attempt-provider-retry",
    });
  });

  it("fences an ambiguous provider rejection without durable not-submitted proof", async () => {
    vi.useFakeTimers();
    manager.submitInput = async (
      _id,
      _text,
      _submit,
      _canWrite,
      _background,
      lifecycle,
    ) => {
      await lifecycle?.beforeFirstWrite?.();
      throw new Error("provider rejected at the Enter boundary");
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-ambiguous-provider-rejection",
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });

    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "generating",
      attemptId: "attempt-ambiguous-provider-rejection",
    });
    expect(
      (
        coordinator as unknown as {
          activeTurnTimers: Map<string, unknown>;
          runtimeEpochs: Map<string, string>;
        }
      ).activeTurnTimers.size,
    ).toBe(1);
    expect(
      (
        coordinator as unknown as {
          runtimeEpochs: Map<string, string>;
        }
      ).runtimeEpochs.get(session.id),
    ).toBe(TEST_RUNTIME_EPOCH);
    await vi.advanceTimersByTimeAsync(300_000);
    await flushCoordinator(coordinator, session.id);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "delivery_timeout",
    });
    expect((await readState(root, session.id)).attempts.at(-1)).toMatchObject({
      attemptId: "attempt-ambiguous-provider-rejection",
      status: "retired",
      phase: "dispatching",
    });
    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapRetryUnavailableError,
    );
    expect(submitted).toEqual([]);
  });

  it("allows retry after a current-schema persistence failure before attempt allocation", async () => {
    let rejectFirstWrite = true;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-after-persistence-recovery",
      deliveryTimeoutMs: 60_000,
      writeState: async (_file, value) => {
        if (rejectFirstWrite) {
          rejectFirstWrite = false;
          throw new Error("injected pre-attempt persistence failure");
        }
        await writeState(root, session.id, value as DurableBootstrapState);
      },
    });

    await expect(
      coordinator.register(session, { emptyProject: true, mode: "created" }),
    ).rejects.toThrow("project bootstrap state persistence failed");
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "persistence_failed",
    });
    expect((await readState(root, session.id)).attempts).toEqual([]);

    await coordinator.retry(session.id);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toContain("attempt-after-persistence-recovery");
  });

  it("allows retry only after a correlated submitted turn reports an empty model result", async () => {
    const ids = ["attempt-empty-model", "attempt-after-empty-model"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: submitted[0]!.text,
      }),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", { assistantText: "   " }),
    );

    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "model_turn_failed",
    });
    expect((await readState(root, session.id)).attempts.at(-1)).toMatchObject({
      attemptId: "attempt-empty-model",
      status: "retired",
      phase: "submitted",
    });

    await coordinator.retry(session.id);

    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.text).toContain("attempt-after-empty-model");
  });

  it.each(["injection_failed", "persistence_failed"] as const)(
    "does not trust legacy phase-less %s retry metadata",
    async (errorCode) => {
      session.projectBootstrap!.bootstrap = {
        status: "failed",
        retryable: true,
        errorCode,
      };
      await writeState(root, session.id, {
        schemaVersion: 2,
        metadata: structuredClone(session.projectBootstrap!),
        inputs: [],
        dispatchingInputId: null,
        retryCount: 0,
        emptyProject: true,
        attempts: [],
      });
      const coordinator = new ProjectBootstrapCoordinator({
        root,
        sessionManager: manager,
      });

      await coordinator.register(session, {
        emptyProject: true,
        mode: "boot",
      });

      expect(session.projectBootstrap?.bootstrap).toEqual({
        status: "failed",
        retryable: false,
        errorCode,
      });
      await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
        ProjectBootstrapRetryUnavailableError,
      );
      expect(submitted).toEqual([]);
    },
  );

  it("durably bounds persistence failures without exposing storage content", async () => {
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      writeState: async () => {
        throw new Error("/private/customer/path provider-secret");
      },
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });

    await expect(
      coordinator.register(session, { emptyProject: true, mode: "created" }),
    ).rejects.toThrow("project bootstrap state persistence failed");
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "persistence_failed",
    });
    const serialized = JSON.stringify(lifecycle);
    expect(serialized).toContain("project_bootstrap.failed");
    expect(serialized).not.toContain("private/customer");
    expect(serialized).not.toContain("provider-secret");
  });

  it("revalidates dispatch authority before bootstrap and queued user input", async () => {
    session.ready = false;
    let authorized = true;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      canDispatch: async () => authorized,
      readinessTimeoutMs: 60_000,
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await coordinator.enqueue(session.id, "durable user request");
    authorized = false;
    session.ready = true;
    await coordinator.onSessionStatus(session);

    expect(submitted).toEqual([]);
    expect(session.projectBootstrap?.queuedInputIds).toHaveLength(1);
    await expect(
      coordinator.enqueue(session.id, "foreign follow-up"),
    ).rejects.toBeInstanceOf(ProjectBootstrapDispatchForbiddenError);
  });

  it("acknowledges a durable enqueue when authority changes after its commit", async () => {
    session.ready = false;
    let authorized = true;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-committed-before-rebind",
      canDispatch: () => authorized,
      readinessTimeoutMs: 60_000,
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    manager.setProjectBootstrapMetadata = async (
      id: string,
      metadata: ProjectBootstrapMetadata,
    ) => {
      const target = sessions.get(id);
      if (!target) throw new Error("session missing");
      target.projectBootstrap = structuredClone(metadata);
      if (metadata.queuedInputIds.length > 0) authorized = false;
    };
    session.ready = true;

    await expect(
      coordinator.enqueue(session.id, "durably accepted before rebind"),
    ).resolves.toMatchObject({
      queuedInputIds: ["input-committed-before-rebind"],
    });
    expect(submitted).toEqual([]);
    expect((await readState(root, session.id)).inputs).toEqual([
      expect.objectContaining({
        id: "input-committed-before-rebind",
        text: "durably accepted before rebind",
      }),
    ]);
  });

  it("deduplicates only explicit durable request IDs and rejects changed payloads", async () => {
    session.ready = false;
    const ids = ["input-keyed", "input-unkeyed-1", "input-unkeyed-2"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      readinessTimeoutMs: 60_000,
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });

    const first = await coordinator.enqueueWithReceipt(
      session.id,
      "implement the scoped request",
      "request-1",
    );
    const replay = await coordinator.enqueueWithReceipt(
      session.id,
      "implement the scoped request",
      "request-1",
    );
    expect(replay).toEqual(first);
    expect(first.receipt).toMatchObject({
      requestId: "request-1",
      inputId: "input-keyed",
      status: "queued",
    });
    await expect(
      coordinator.enqueueWithReceipt(
        session.id,
        "different payload",
        "request-1",
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapRequestIdConflictError);

    await coordinator.enqueue(session.id, "same text without a key");
    await coordinator.enqueue(session.id, "same text without a key");
    const durable = await readState(root, session.id);
    expect(durable.inputs.map((input) => input.id)).toEqual([
      "input-keyed",
      "input-unkeyed-1",
      "input-unkeyed-2",
    ]);
    expect(durable.receipts).toHaveLength(3);
  });

  it("bounds and compacts keyed and unkeyed receipt storage without persisting payload copies", async () => {
    session.ready = false;
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const oldReceipts = Array.from({ length: 128 }, (_, index) => ({
      requestId: index % 2 === 0 ? null : `old-request-${index}`,
      inputId: `old-input-${index}`,
      status: "completed" as const,
      acceptedAt: NOW,
      payloadDigest: index.toString(16).padStart(64, "0"),
      leakedText: "receipt-only secret",
    }));
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs: [],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: false,
      attempts: [],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: oldReceipts,
    });
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const ids = ["new-unkeyed-input", "new-keyed-input"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    await coordinator.enqueueWithReceipt(session.id, "first private payload");
    await coordinator.enqueueWithReceipt(
      session.id,
      "second private payload",
      "new-keyed-request",
    );

    const durable = await readState(root, session.id);
    expect(durable.receipts).toHaveLength(128);
    expect(durable.receipts).not.toContainEqual(
      expect.objectContaining({ inputId: "old-input-0" }),
    );
    expect(durable.receipts).not.toContainEqual(
      expect.objectContaining({ inputId: "old-input-2" }),
    );
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: null,
          inputId: "new-unkeyed-input",
          status: "queued",
        }),
        expect.objectContaining({
          requestId: "new-keyed-request",
          inputId: "new-keyed-input",
          status: "queued",
        }),
      ]),
    );
    for (const receipt of durable.receipts ?? []) {
      expect(Object.keys(receipt).sort()).toEqual([
        "acceptedAt",
        "inputId",
        "payloadDigest",
        "requestId",
        "status",
      ]);
      expect(receipt.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(durable.receipts)).not.toContain(
      "first private payload",
    );
    expect(JSON.stringify(durable.receipts)).not.toContain(
      "second private payload",
    );
    expect(JSON.stringify(durable.receipts)).not.toContain(
      "receipt-only secret",
    );
    expect(JSON.stringify(lifecycle)).not.toContain("private payload");
    expect(JSON.stringify(lifecycle)).not.toContain("receipt-only secret");
  });

  it("fails closed when every bounded receipt still owns queued work", async () => {
    session.ready = false;
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const inputs = Array.from({ length: 128 }, (_, index) => ({
      id: `queued-input-${index}`,
      sessionId: session.id,
      text: `queued payload ${index}`,
      acceptedAt: NOW,
    }));
    session.projectBootstrap!.queuedInputIds = inputs.map((input) => input.id);
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs,
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: false,
      attempts: [],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: inputs.map((input, index) => ({
        requestId: index % 2 === 0 ? null : `queued-request-${index}`,
        inputId: input.id,
        status: "queued" as const,
        acceptedAt: NOW,
        payloadDigest: createHash("sha256")
          .update(
            JSON.stringify({
              schemaVersion: 1,
              submit: true,
              text: input.text,
            }),
          )
          .digest("hex"),
      })),
    });
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    await expect(
      coordinator.enqueueWithReceipt(
        session.id,
        "queued payload 1",
        "queued-request-1",
      ),
    ).resolves.toMatchObject({
      receipt: {
        requestId: "queued-request-1",
        inputId: "queued-input-1",
        status: "queued",
      },
    });
    await expect(
      coordinator.enqueueWithReceipt(
        session.id,
        "changed payload at capacity",
        "queued-request-1",
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapRequestIdConflictError);
    await expect(
      coordinator.enqueueWithReceipt(
        session.id,
        "one beyond the bound",
        "genuinely-new-request",
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapInputCapacityError);
    expect((await readState(root, session.id)).receipts).toHaveLength(128);
  });

  it("returns the same uncertain receipt after restart without replaying a response-loss retry", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "skipped",
      reason: "user-proceeded",
    };
    session.projectBootstrap!.queuedInputIds = ["input-response-lost"];
    const payload = "durable request whose response was lost";
    const payloadDigest = createHash("sha256")
      .update(JSON.stringify({ schemaVersion: 1, submit: true, text: payload }))
      .digest("hex");
    await writeState(root, session.id, {
      schemaVersion: 3,
      metadata: structuredClone(session.projectBootstrap!),
      inputs: [
        {
          id: "input-response-lost",
          sessionId: session.id,
          text: payload,
          acceptedAt: NOW,
        },
      ],
      dispatchingInputId: "input-response-lost",
      retryCount: 0,
      emptyProject: true,
      attempts: [],
      uncertainInputIds: [],
      uncertainInputs: [],
      receipts: [
        {
          requestId: "request-response-lost",
          inputId: "input-response-lost",
          status: "queued",
          acceptedAt: NOW,
          payloadDigest,
        },
      ],
    });

    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await restarted.register(session, { emptyProject: true, mode: "boot" });
    const replay = await restarted.enqueueWithReceipt(
      session.id,
      payload,
      "request-response-lost",
    );

    expect(submitted).toEqual([]);
    expect(replay.receipt).toEqual({
      requestId: "request-response-lost",
      inputId: "input-response-lost",
      status: "uncertain",
      acceptedAt: NOW,
    });
    expect(replay.metadata.queuedInputIds).toEqual([]);
    expect(restarted.ownsInput(session.id, "request-response-lost")).toBe(true);
  });

  it("returns one completed keyed receipt before and after restart without another PTY submission", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-completed-once",
      now: () => NOW,
      deliveryTimeoutMs: 60_000,
    });
    await first.register(session, { emptyProject: false, mode: "boot" });
    const accepted = await first.enqueueWithReceipt(
      session.id,
      "complete this logical input once",
      "request-completed-once",
    );
    expect(accepted.receipt.status).toBe("submitted");
    first.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "complete this logical input once",
      }),
    );
    await first.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "done",
      }),
    );

    const replayBeforeRestart = await first.enqueueWithReceipt(
      session.id,
      "complete this logical input once",
      "request-completed-once",
    );
    expect(replayBeforeRestart.receipt).toEqual({
      requestId: "request-completed-once",
      inputId: "input-completed-once",
      status: "completed",
      acceptedAt: NOW,
    });
    expect(submitted.map((entry) => entry.text)).toEqual([
      "complete this logical input once",
    ]);

    await first.close();
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await restarted.register(session, { emptyProject: false, mode: "boot" });
    const replayAfterRestart = await restarted.enqueueWithReceipt(
      session.id,
      "complete this logical input once",
      "request-completed-once",
    );
    expect(replayAfterRestart).toEqual(replayBeforeRestart);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "complete this logical input once",
    ]);
    expect((await readState(root, session.id)).inputs).toEqual([]);
  });

  it("reconciles a durable PTY acknowledgement after queue cleanup fails without resubmitting", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    let failCommittedDequeue = false;
    let failedOnce = false;
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-accepted-before-cleanup-failure",
      writeState: async (_file, value) => {
        const durable = value as DurableBootstrapState;
        if (
          failCommittedDequeue &&
          !failedOnce &&
          durable.inputs.length === 0 &&
          durable.receipts?.some(
            (receipt) =>
              receipt.inputId === "input-accepted-before-cleanup-failure" &&
              receipt.status === "submitted",
          )
        ) {
          failedOnce = true;
          throw new Error("injected dequeue persistence failure");
        }
        await writeState(root, session.id, durable);
      },
    });
    await first.register(session, { emptyProject: false, mode: "boot" });
    failCommittedDequeue = true;

    await first.enqueueWithReceipt(
      session.id,
      "send exactly once",
      "request-cleanup-recovery",
    );
    expect(submitted.map((entry) => entry.text)).toEqual(["send exactly once"]);
    expect((await readState(root, session.id)).dispatchingInputId).toBe(
      "input-accepted-before-cleanup-failure",
    );
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, session.id, "accepted-inputs.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      inputIds: ["input-accepted-before-cleanup-failure"],
    });

    await first.close();
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await restarted.register(session, { emptyProject: false, mode: "boot" });
    const replay = await restarted.enqueueWithReceipt(
      session.id,
      "send exactly once",
      "request-cleanup-recovery",
    );

    expect(submitted.map((entry) => entry.text)).toEqual(["send exactly once"]);
    expect(replay.receipt.status).toBe("uncertain");
    const recovered = await readState(root, session.id);
    expect(recovered.inputs).toEqual([]);
    expect(recovered.uncertainInputs).toEqual([
      expect.objectContaining({
        id: "input-accepted-before-cleanup-failure",
        text: "send exactly once",
      }),
    ]);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, session.id, "accepted-inputs.json"),
          "utf8",
        ),
      ),
    ).toEqual({ schemaVersion: 1, inputIds: [] });
  });

  it("retries a durable FIFO head only after a pre-Enter rejection is durably rolled back", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = ["input-pre-enter-a", "input-after-pre-enter-b"];
    let firstAttempts = 0;
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (text === "turn A rejected before Enter") {
        firstAttempts += 1;
        if (firstAttempts === 1) {
          await lifecycle?.onNotSubmitted?.();
          throw new Error("injected pre-Enter text rejection");
        }
      }
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    const first = await coordinator.enqueueWithReceipt(
      session.id,
      "turn A rejected before Enter",
      "request-pre-enter-a",
    );
    expect(first.receipt.status).toBe("queued");
    expect(firstAttempts).toBe(1);
    expect(submitted).toEqual([]);
    expect(await readState(root, session.id)).toMatchObject({
      dispatchingInputId: null,
      inputs: [expect.objectContaining({ id: "input-pre-enter-a" })],
    });

    await coordinator.enqueueWithReceipt(
      session.id,
      "turn B waits for A",
      "request-pre-enter-b",
    );
    expect(firstAttempts).toBe(2);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn A rejected before Enter",
    ]);

    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "turn A rejected before Enter",
      }),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "A completed after its one safe retry",
      }),
    );

    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn A rejected before Enter",
      "turn B waits for A",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-pre-enter-a",
          status: "completed",
        }),
        expect.objectContaining({
          inputId: "input-after-pre-enter-b",
          status: "submitted",
        }),
      ]),
    );
  });

  it("holds an ambiguous FIFO Enter rejection until A's deadline and admits B once", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = ["input-ambiguous-a", "input-after-ambiguous-b"];
    const enterAttempts: string[] = [];
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      enterAttempts.push(text);
      if (text === "turn A has an ambiguous Enter rejection") {
        throw new Error("injected ambiguous Enter rejection");
      }
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    const first = await coordinator.enqueueWithReceipt(
      session.id,
      "turn A has an ambiguous Enter rejection",
      "request-ambiguous-a",
    );
    expect(first.receipt.status).toBe("submitted");
    await coordinator.enqueueWithReceipt(
      session.id,
      "turn B waits behind ambiguous A",
      "request-ambiguous-b",
    );
    expect(enterAttempts).toEqual(["turn A has an ambiguous Enter rejection"]);
    expect(await readState(root, session.id)).toMatchObject({
      dispatchingInputId: "input-ambiguous-a",
      receipts: expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-ambiguous-a",
          status: "submitted",
        }),
        expect.objectContaining({
          inputId: "input-after-ambiguous-b",
          status: "queued",
        }),
      ]),
    });

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    expect(enterAttempts).toEqual([
      "turn A has an ambiguous Enter rejection",
      "turn B waits behind ambiguous A",
    ]);
    let durable = await readState(root, session.id);
    expect(durable.dispatchingInputId).toBeNull();
    expect(durable.inputs).toEqual([]);
    expect(durable.uncertainInputs).toContainEqual(
      expect.objectContaining({ id: "input-ambiguous-a" }),
    );
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-ambiguous-a",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "input-after-ambiguous-b",
          status: "submitted",
        }),
      ]),
    );

    // A's late completion consumes only A's correlation. It cannot clear B's
    // active ownership, alter A's terminal uncertainty, or submit B twice.
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "turn A has an ambiguous Enter rejection",
      }),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "A eventually completed",
      }),
    );
    durable = await readState(root, session.id);
    expect(
      durable.receipts?.find(
        (receipt) => receipt.inputId === "input-ambiguous-a",
      )?.status,
    ).toBe("uncertain");
    expect(enterAttempts).toEqual([
      "turn A has an ambiguous Enter rejection",
      "turn B waits behind ambiguous A",
    ]);
    expect(coordinator.ownsInput(session.id)).toBe(true);
  });

  it("atomically completes an ambiguous FIFO dispatch before admitting B", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = ["input-completed-ambiguous-a", "input-after-completed-b"];
    const enterAttempts: string[] = [];
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      enterAttempts.push(text);
      if (text === "turn A completes despite ambiguous Enter") {
        throw new Error("injected ambiguous Enter rejection");
      }
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
    });
    await first.register(session, { emptyProject: false, mode: "boot" });
    await first.enqueueWithReceipt(
      session.id,
      "turn A completes despite ambiguous Enter",
      "request-completed-ambiguous-a",
    );
    await first.enqueueWithReceipt(
      session.id,
      "turn B follows completed A",
      "request-after-completed-b",
    );

    first.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "turn A completes despite ambiguous Enter",
      }),
    );
    await first.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "A completed before its deadline",
      }),
    );

    expect(enterAttempts).toEqual([
      "turn A completes despite ambiguous Enter",
      "turn B follows completed A",
    ]);
    let durable = await readState(root, session.id);
    expect(durable.dispatchingInputId).toBeNull();
    expect(durable.inputs).toEqual([]);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-completed-ambiguous-a",
          status: "completed",
        }),
        expect.objectContaining({
          inputId: "input-after-completed-b",
          status: "submitted",
        }),
      ]),
    );

    // A's timer was removed only after its atomic completion commit. Advancing
    // the old deadline can expire B, but can never downgrade or replay A.
    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(first, session.id);
    durable = await readState(root, session.id);
    expect(
      durable.receipts?.find(
        (receipt) => receipt.inputId === "input-completed-ambiguous-a",
      )?.status,
    ).toBe("completed");
    expect(enterAttempts).toEqual([
      "turn A completes despite ambiguous Enter",
      "turn B follows completed A",
    ]);

    await first.close();
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 100,
    });
    await restarted.register(session, { emptyProject: false, mode: "boot" });
    const replay = await restarted.enqueueWithReceipt(
      session.id,
      "turn A completes despite ambiguous Enter",
      "request-completed-ambiguous-a",
    );
    expect(replay.receipt.status).toBe("completed");
    expect(enterAttempts).toEqual([
      "turn A completes despite ambiguous Enter",
      "turn B follows completed A",
    ]);
    durable = await readState(root, session.id);
    expect(
      durable.receipts?.find(
        (receipt) => receipt.inputId === "input-completed-ambiguous-a",
      )?.status,
    ).toBe("completed");
  });

  it("retains A's deadline when its correlated completion cannot be persisted", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = [
      "input-failed-completion-a",
      "input-after-failed-completion-b",
    ];
    const enterAttempts: string[] = [];
    let failCompletionCommit = false;
    let completionCommitFailed = false;
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      enterAttempts.push(text);
      if (text === "turn A completion cannot commit") {
        throw new Error("injected ambiguous Enter rejection");
      }
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
      writeState: async (_file, value) => {
        const durable = value as DurableBootstrapState;
        if (
          failCompletionCommit &&
          !completionCommitFailed &&
          durable.inputs.every(
            (input) => input.id !== "input-failed-completion-a",
          ) &&
          durable.receipts?.some(
            (receipt) =>
              receipt.inputId === "input-failed-completion-a" &&
              receipt.status === "completed",
          )
        ) {
          completionCommitFailed = true;
          throw new Error("injected completed dequeue persistence failure");
        }
        await writeState(root, session.id, durable);
      },
    });
    await first.register(session, { emptyProject: false, mode: "boot" });
    await first.enqueueWithReceipt(
      session.id,
      "turn A completion cannot commit",
      "request-failed-completion-a",
    );
    await first.enqueueWithReceipt(
      session.id,
      "turn B waits for bounded completion recovery",
      "request-after-failed-completion-b",
    );
    first.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "turn A completion cannot commit",
      }),
    );
    failCompletionCommit = true;

    await expect(
      first.onEventPersisted(
        analyticsEvent(session.id, "turn.completed", {
          assistantText: "A completed but its dequeue write failed",
        }),
      ),
    ).rejects.toThrow("project bootstrap state persistence failed");
    expect(completionCommitFailed).toBe(true);
    expect(enterAttempts).toEqual(["turn A completion cannot commit"]);
    expect(await readState(root, session.id)).toMatchObject({
      dispatchingInputId: "input-failed-completion-a",
      receipts: expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-failed-completion-a",
          status: "submitted",
        }),
      ]),
    });

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(first, session.id);

    expect(enterAttempts).toEqual([
      "turn A completion cannot commit",
      "turn B waits for bounded completion recovery",
    ]);
    let durable = await readState(root, session.id);
    expect(durable.inputs).toEqual([]);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-failed-completion-a",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "input-after-failed-completion-b",
          status: "submitted",
        }),
      ]),
    );
    const replayBeforeRestart = await first.enqueueWithReceipt(
      session.id,
      "turn A completion cannot commit",
      "request-failed-completion-a",
    );
    expect(replayBeforeRestart.receipt.status).toBe("uncertain");
    expect(enterAttempts).toHaveLength(2);

    await first.close();
    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 100,
    });
    await restarted.register(session, { emptyProject: false, mode: "boot" });
    const replayAfterRestart = await restarted.enqueueWithReceipt(
      session.id,
      "turn A completion cannot commit",
      "request-failed-completion-a",
    );
    expect(replayAfterRestart.receipt.status).toBe("uncertain");
    expect(enterAttempts).toEqual([
      "turn A completion cannot commit",
      "turn B waits for bounded completion recovery",
    ]);
    durable = await readState(root, session.id);
    expect(
      durable.receipts?.find(
        (receipt) => receipt.inputId === "input-failed-completion-a",
      )?.status,
    ).toBe("uncertain");
  });

  it("does not replay an ambiguous FIFO Enter rejection after restart", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = ["input-restart-ambiguous-a", "input-restart-successor-b"];
    const enterAttempts: string[] = [];
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      enterAttempts.push(text);
      if (text === "turn A is ambiguous across restart") {
        throw new Error("injected ambiguous Enter rejection");
      }
      submitted.push({ sessionId: id, text, submit, background });
      return true;
    };
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 60_000,
    });
    await first.register(session, { emptyProject: false, mode: "boot" });
    await first.enqueueWithReceipt(
      session.id,
      "turn A is ambiguous across restart",
      "request-restart-ambiguous-a",
    );
    await first.enqueueWithReceipt(
      session.id,
      "turn B may run after restart",
      "request-restart-successor-b",
    );
    expect(enterAttempts).toEqual(["turn A is ambiguous across restart"]);
    await first.close();

    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await restarted.register(session, { emptyProject: false, mode: "boot" });

    expect(enterAttempts).toEqual([
      "turn A is ambiguous across restart",
      "turn B may run after restart",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.inputs).toEqual([]);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-restart-ambiguous-a",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "input-restart-successor-b",
          status: "submitted",
        }),
      ]),
    );
  });

  it("keeps a bounded turn deadline when the first post-Enter state write fails", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = ["input-post-enter-failure", "input-after-failure"];
    let failSubmittedState = false;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
      writeState: async (_file, value) => {
        const durable = value as DurableBootstrapState;
        if (
          failSubmittedState &&
          durable.dispatchingInputId === "input-post-enter-failure" &&
          durable.receipts?.some(
            (receipt) =>
              receipt.inputId === "input-post-enter-failure" &&
              receipt.status === "submitted",
          )
        ) {
          throw new Error("injected submitted-state persistence failure");
        }
        await writeState(root, session.id, durable);
      },
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });
    failSubmittedState = true;

    await coordinator.enqueueWithReceipt(
      session.id,
      "turn whose post-Enter write fails",
      "request-post-enter-failure",
    );
    failSubmittedState = false;
    await coordinator.enqueueWithReceipt(
      session.id,
      "turn waiting behind the failure",
      "request-after-failure",
    );

    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn whose post-Enter write fails",
    ]);
    expect(coordinator.ownsInput(session.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn whose post-Enter write fails",
      "turn waiting behind the failure",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-post-enter-failure",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "input-after-failure",
          status: "submitted",
        }),
      ]),
    );
    expect(durable.inputs).toEqual([]);
  });

  it("releases one successor when the accepted-input ledger write fails after Enter", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = ["input-ledger-failure", "input-after-ledger-failure"];
    let failAcceptedLedger = true;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
      writeAcceptedLedger: async (file, value) => {
        const ledger = value as { inputIds: string[] };
        if (
          failAcceptedLedger &&
          ledger.inputIds.includes("input-ledger-failure")
        ) {
          failAcceptedLedger = false;
          throw new Error("injected accepted-input ledger failure");
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(value)}\n`);
      },
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    await coordinator.enqueueWithReceipt(
      session.id,
      "turn whose accepted ledger write fails",
      "request-ledger-failure",
    );
    await coordinator.enqueueWithReceipt(
      session.id,
      "turn waiting behind the ledger failure",
      "request-after-ledger-failure",
    );

    expect(failAcceptedLedger).toBe(false);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn whose accepted ledger write fails",
    ]);
    expect(await readState(root, session.id)).toMatchObject({
      dispatchingInputId: "input-ledger-failure",
      receipts: expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-ledger-failure",
          status: "submitted",
        }),
      ]),
    });
    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn whose accepted ledger write fails",
      "turn waiting behind the ledger failure",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-ledger-failure",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "input-after-ledger-failure",
          status: "submitted",
        }),
      ]),
    );
    expect(durable.inputs).toEqual([]);
    expect(durable.uncertainInputs).toContainEqual(
      expect.objectContaining({ id: "input-ledger-failure" }),
    );
  });

  it("reconciles an accepted input after live dequeue persistence fails before admitting one successor", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = ["input-dequeue-failure", "input-after-dequeue-failure"];
    let failCommittedDequeue = true;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
      writeState: async (_file, value) => {
        const durable = value as DurableBootstrapState;
        if (
          failCommittedDequeue &&
          durable.inputs.every(
            (input) => input.id !== "input-dequeue-failure",
          ) &&
          durable.receipts?.some(
            (receipt) =>
              receipt.inputId === "input-dequeue-failure" &&
              receipt.status === "submitted",
          )
        ) {
          failCommittedDequeue = false;
          throw new Error("injected dequeue persistence failure");
        }
        await writeState(root, session.id, durable);
      },
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    await coordinator.enqueueWithReceipt(
      session.id,
      "turn whose dequeue persistence fails",
      "request-dequeue-failure",
    );
    await coordinator.enqueueWithReceipt(
      session.id,
      "turn waiting behind the dequeue failure",
      "request-after-dequeue-failure",
    );

    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn whose dequeue persistence fails",
    ]);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, session.id, "accepted-inputs.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ inputIds: ["input-dequeue-failure"] });
    expect(failCommittedDequeue).toBe(false);

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    expect(submitted.map((entry) => entry.text)).toEqual([
      "turn whose dequeue persistence fails",
      "turn waiting behind the dequeue failure",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "input-dequeue-failure",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "input-after-dequeue-failure",
          status: "submitted",
        }),
      ]),
    );
    expect(durable.inputs).toEqual([]);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, session.id, "accepted-inputs.json"),
          "utf8",
        ),
      ),
    ).toEqual({ schemaVersion: 1, inputIds: [] });
  });

  it("does not retain a timer after completion observed during submission", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    let completion: Promise<void> | undefined;
    manager.submitInput = async (
      id: string,
      text: string,
      submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      if (canWrite && !(await canWrite())) return false;
      await lifecycle?.beforeFirstWrite?.();
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) return false;
      submitted.push({ sessionId: id, text, submit, background });
      coordinator.decorateLocalEvent(
        analyticsEvent(session.id, "prompt.submitted", { prompt: text }),
      );
      completion = coordinator.onEventPersisted(
        analyticsEvent(session.id, "turn.completed", {
          assistantText: "completed immediately",
        }),
      );
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-immediate-completion",
      deliveryTimeoutMs: 100,
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    await coordinator.enqueueWithReceipt(
      session.id,
      "complete while submission unwinds",
      "request-immediate-completion",
    );
    await completion;

    const internals = coordinator as unknown as {
      activeTurns: Map<string, unknown>;
      activeTurnTimers: Map<string, unknown>;
    };
    expect(internals.activeTurns.has(session.id)).toBe(false);
    expect(internals.activeTurnTimers.has(session.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    expect(
      (
        await coordinator.enqueueWithReceipt(
          session.id,
          "complete while submission unwinds",
          "request-immediate-completion",
        )
      ).receipt.status,
    ).toBe("completed");
    expect(submitted).toHaveLength(1);
  });

  it("redrains once after recognized setup input becomes ready without a model event", async () => {
    session.ready = false;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-after-setup",
      readinessTimeoutMs: 60_000,
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await coordinator.enqueue(session.id, "build immediately after setup");

    coordinator.onTerminalInput(session.id, { blockingPrompt: true });
    session.ready = true;
    await coordinator.onSessionStatus(session);

    expect(submitted.map((entry) => entry.text)).toEqual([
      "build immediately after setup",
    ]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual([]);
    expect(
      (
        coordinator as unknown as {
          terminalPreemptions: Set<string>;
        }
      ).terminalPreemptions.has(session.id),
    ).toBe(false);
  });

  it("releases durable user input after a submitted bootstrap reaches its bounded timeout", async () => {
    vi.useFakeTimers();
    const ids = ["attempt-hung", "input-behind-hung-bootstrap"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await coordinator.enqueue(session.id, "user build request wins next");
    expect(submitted.map((entry) => entry.text)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    expect(submitted.map((entry) => entry.text)).toEqual([
      expect.stringContaining("Agent Studio project bootstrap"),
      "user build request wins next",
    ]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
  });

  it("holds each API turn after dequeue and releases one successor per bounded timeout", async () => {
    vi.useFakeTimers();
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    const ids = [
      "first-active-input",
      "second-waiting-input",
      "third-waiting-input",
    ];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => ids.shift() ?? "unexpected-id",
      deliveryTimeoutMs: 100,
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    const first = await coordinator.enqueueWithReceipt(
      session.id,
      "first server-owned turn",
      "request-first-active",
    );
    expect(first.receipt.status).toBe("submitted");
    expect((await readState(root, session.id)).inputs).toEqual([]);
    expect(coordinator.ownsInput(session.id)).toBe(true);

    const second = await coordinator.enqueueWithReceipt(
      session.id,
      "second server-owned turn",
      "request-second-waiting",
    );
    expect(second.receipt.status).toBe("queued");
    const third = await coordinator.enqueueWithReceipt(
      session.id,
      "third server-owned turn",
      "request-third-waiting",
    );
    expect(third.receipt.status).toBe("queued");
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first server-owned turn",
    ]);

    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);

    expect(submitted.map((entry) => entry.text)).toEqual([
      "first server-owned turn",
      "second server-owned turn",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "first-active-input",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "second-waiting-input",
          status: "submitted",
        }),
        expect.objectContaining({
          inputId: "third-waiting-input",
          status: "queued",
        }),
      ]),
    );
    expect(durable.inputs).toEqual([
      expect.objectContaining({ id: "third-waiting-input" }),
    ]);

    // A late completion for A consumes only A's correlation. It cannot change
    // A's terminal uncertainty, clear B, or advance C.
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "first server-owned turn",
      }),
    );
    await coordinator.onEventPersisted(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "first eventually finished",
      }),
    );
    let afterLateCompletion = await readState(root, session.id);
    expect(afterLateCompletion.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "first-active-input",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "second-waiting-input",
          status: "submitted",
        }),
      ]),
    );
    expect(afterLateCompletion.inputs).toEqual([
      expect.objectContaining({ id: "third-waiting-input" }),
    ]);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first server-owned turn",
      "second server-owned turn",
    ]);

    // B owns a distinct deadline. Its timeout terminalizes only B, then admits
    // exactly one successor C.
    await vi.advanceTimersByTimeAsync(101);
    await flushCoordinator(coordinator, session.id);
    expect(submitted.map((entry) => entry.text)).toEqual([
      "first server-owned turn",
      "second server-owned turn",
      "third server-owned turn",
    ]);
    afterLateCompletion = await readState(root, session.id);
    expect(afterLateCompletion.inputs).toEqual([]);
    expect(afterLateCompletion.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputId: "first-active-input",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "second-waiting-input",
          status: "uncertain",
        }),
        expect.objectContaining({
          inputId: "third-waiting-input",
          status: "submitted",
        }),
      ]),
    );
  });

  it("fences the final PTY boundary and leaves no acknowledgement when close wins", async () => {
    const writes: string[] = [];
    let finalAuthorizationReached!: () => void;
    const atFinalAuthorization = new Promise<void>((resolve) => {
      finalAuthorizationReached = resolve;
    });
    let releaseFinalBoundary!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseFinalBoundary = resolve;
    });
    manager.submitInput = async (
      _id: string,
      text: string,
      _submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      _background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      await lifecycle?.beforeFirstWrite?.();
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) {
        throw new SessionInputGuardRejectedError(false);
      }
      writes.push(text);
      if (canWrite && !(await canWrite())) {
        throw new SessionInputGuardRejectedError(true);
      }
      finalAuthorizationReached();
      await released;
      if (lifecycle?.canWriteNow && !lifecycle.canWriteNow()) {
        writes.push("\x15");
        throw new SessionInputGuardRejectedError(true);
      }
      writes.push("\r");
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-close-fence",
      deliveryTimeoutMs: 60_000,
    });
    const registering = coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    await atFinalAuthorization;
    const closing = coordinator.close();
    releaseFinalBoundary();
    await Promise.all([registering, closing]);

    expect(writes).toEqual([
      expect.stringContaining("Agent Studio project bootstrap"),
      "\x15",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.attempts[0]).toMatchObject({
      attemptId: "attempt-close-fence",
      phase: "dispatching",
    });
    await expect(
      fs.readFile(path.join(root, session.id, "accepted-inputs.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a durable uncertain intent when shutdown starts after Enter but before acknowledgement", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    let closing: Promise<void> | undefined;
    manager.submitInput = async (
      _id: string,
      text: string,
      _submit?: boolean,
      canWrite?: () => boolean | Promise<boolean>,
      _background?: boolean,
      lifecycle?: SessionInputWriteLifecycle,
    ) => {
      await lifecycle?.beforeFirstWrite?.();
      if (canWrite && !(await canWrite())) return false;
      submitted.push({
        sessionId: session.id,
        text,
        submit: true,
        background: false,
      });
      closing = coordinator.close();
      return true;
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-entered-before-close",
    });
    await coordinator.register(session, { emptyProject: false, mode: "boot" });

    await coordinator.enqueueWithReceipt(
      session.id,
      "entered before shutdown",
      "request-entered-before-close",
    );
    await closing;

    expect(submitted.map((entry) => entry.text)).toEqual([
      "entered before shutdown",
    ]);
    const durable = await readState(root, session.id);
    expect(durable.dispatchingInputId).toBe("input-entered-before-close");
    expect(durable.receipts).toContainEqual(
      expect.objectContaining({
        requestId: "request-entered-before-close",
        inputId: "input-entered-before-close",
        status: "submitted",
      }),
    );
    await expect(
      fs.readFile(path.join(root, session.id, "accepted-inputs.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await restarted.register(session, { emptyProject: false, mode: "boot" });
    const replay = await restarted.enqueueWithReceipt(
      session.id,
      "entered before shutdown",
      "request-entered-before-close",
    );
    expect(replay.receipt.status).toBe("uncertain");
    expect(submitted.map((entry) => entry.text)).toEqual([
      "entered before shutdown",
    ]);
    const recovered = await readState(root, session.id);
    expect(recovered.dispatchingInputId).toBeNull();
    expect(recovered.inputs).toEqual([]);
    expect(recovered.uncertainInputs).toEqual([
      expect.objectContaining({ id: "input-entered-before-close" }),
    ]);
    await expect(
      fs.readFile(path.join(root, session.id, "accepted-inputs.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers only the pending claim transition after both claim stores reject", async () => {
    vi.useFakeTimers();
    let rejectClaimStores = true;
    let allocatedAttempts = 0;
    const setMetadata = manager.setProjectBootstrapMetadata.bind(manager);
    manager.setProjectBootstrapMetadata = async (id, metadata) => {
      if (rejectClaimStores && metadata.bootstrap.status === "failed") {
        throw new Error("injected sessions projection failure");
      }
      await setMetadata(id, metadata);
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      readinessTimeoutMs: 50,
      generateId: () => {
        allocatedAttempts += 1;
        return "claim-that-never-committed";
      },
      writeState: async (_file, value) => {
        const durable = value as DurableBootstrapState;
        if (
          rejectClaimStores &&
          (durable.metadata.bootstrap.status === "generating" ||
            durable.metadata.bootstrap.status === "failed")
        ) {
          throw new Error("injected queue-store failure");
        }
        await writeState(root, session.id, durable);
      },
    });

    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(allocatedAttempts).toBe(1);
    expect(submitted).toEqual([]);
    expect((await readState(root, session.id)).metadata.bootstrap).toEqual({
      status: "pending",
    });

    rejectClaimStores = false;
    await vi.advanceTimersByTimeAsync(51);
    await flushCoordinator(coordinator, session.id);

    expect(allocatedAttempts).toBe(1);
    expect(submitted).toEqual([]);
    expect(session.projectBootstrap?.bootstrap).toEqual({
      status: "failed",
      retryable: true,
      errorCode: "persistence_failed",
    });
    expect(
      (coordinator as unknown as { timers: Map<string, unknown> }).timers.size,
    ).toBe(0);
    expect(
      (
        coordinator as unknown as {
          pendingBootstrapFailureTransitions: Map<string, unknown>;
        }
      ).pendingBootstrapFailureTransitions.size,
    ).toBe(0);
  });

  it("fences coordinator-owned completion and status events to one runtime epoch", async () => {
    let liveEpoch: string | null = "epoch-a";
    manager.getRuntimeEpoch = () => liveEpoch;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-epoch-a",
    });
    await coordinator.register(
      session,
      { emptyProject: true, mode: "created" },
      "epoch-a",
    );
    const prompt = submitted[0]!.text;
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", { prompt }),
      "epoch-a",
    );

    liveEpoch = null;
    await coordinator.transitionRuntimeEpoch(
      { ...session, status: "starting", ready: false },
      "epoch-b",
    );
    liveEpoch = "epoch-b";
    session.status = "running";
    session.ready = true;
    await coordinator.register(
      session,
      { emptyProject: true, mode: "resumed" },
      "epoch-b",
    );
    const afterTransition = await readState(root, session.id);
    expect(afterTransition.metadata.bootstrap).toEqual({
      status: "failed",
      retryable: false,
      errorCode: "session_exited",
    });

    const late = analyticsEvent(
      session.id,
      "turn.completed",
      { assistantText: "late old-process completion" },
      "late-epoch-a-completion",
    );
    await coordinator.onEventPersisted(late, "epoch-a");
    await coordinator.onSessionStatus(
      { ...session, status: "exited", ready: false },
      "epoch-a",
    );
    expect(await readState(root, session.id)).toEqual(afterTransition);
    expect(
      coordinator.decorateLocalEvent(
        analyticsEvent(session.id, "prompt.submitted", { prompt }),
        "epoch-a",
      ).payload,
    ).not.toHaveProperty("projectBootstrapAttemptId");
  });

  it("terminalizes an old user turn before admitting a replacement runtime", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    let liveEpoch: string | null = "epoch-a";
    manager.getRuntimeEpoch = () => liveEpoch;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-owned-by-epoch-a",
    });
    await coordinator.register(
      session,
      { emptyProject: false, mode: "created" },
      "epoch-a",
    );
    const accepted = await coordinator.enqueueWithReceipt(
      session.id,
      "build from runtime A",
      "request-runtime-a",
    );
    expect(accepted.receipt.status).toBe("submitted");

    liveEpoch = null;
    await coordinator.transitionRuntimeEpoch(
      { ...session, status: "starting", ready: false },
      "epoch-b",
    );
    liveEpoch = "epoch-b";
    session.status = "running";
    session.ready = true;
    await coordinator.register(
      session,
      { emptyProject: false, mode: "resumed" },
      "epoch-b",
    );
    const durable = await readState(root, session.id);
    expect(durable.receipts).toContainEqual(
      expect.objectContaining({
        requestId: "request-runtime-a",
        status: "uncertain",
      }),
    );

    await coordinator.onEventPersisted(
      analyticsEvent(
        session.id,
        "turn.completed",
        { assistantText: "late runtime A reply" },
        "runtime-a-late-turn",
      ),
      "epoch-a",
    );
    expect((await readState(root, session.id)).receipts).toEqual(
      durable.receipts,
    );
  });

  it("clears an old raw-terminal hold before admitting the replacement runtime", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    let liveEpoch: string | null = "epoch-a";
    manager.getRuntimeEpoch = () => liveEpoch;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "input-owned-by-epoch-b",
    });
    await coordinator.register(
      session,
      { emptyProject: false, mode: "created" },
      "epoch-a",
    );
    coordinator.onTerminalInput(session.id, {
      runtimeEpoch: "epoch-a",
      blockingPrompt: false,
    });
    coordinator.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: "raw input owned by runtime A",
      }),
      "epoch-a",
    );
    await flushCoordinator(coordinator, session.id);

    liveEpoch = null;
    await coordinator.transitionRuntimeEpoch(
      { ...session, status: "starting", ready: false },
      "epoch-b",
    );
    liveEpoch = "epoch-b";
    await coordinator.register(
      session,
      { emptyProject: false, mode: "resumed" },
      "epoch-b",
    );
    const accepted = await coordinator.enqueueWithReceipt(
      session.id,
      "build on runtime B",
      "request-runtime-b",
    );
    expect(accepted.receipt.status).toBe("submitted");
    expect(submitted.map((entry) => entry.text)).toEqual([
      "build on runtime B",
    ]);

    const beforeLateCompletion = await readState(root, session.id);
    await coordinator.onEventPersisted(
      analyticsEvent(
        session.id,
        "turn.completed",
        { assistantText: "late runtime A reply" },
        "runtime-a-late-raw-turn",
      ),
      "epoch-a",
    );
    await coordinator.onSessionStatus(
      { ...session, status: "exited", ready: false },
      "epoch-a",
    );
    expect(await readState(root, session.id)).toEqual(beforeLateCompletion);
  });

  it("returns an exited keyed receipt idempotently but denies new or rebound input", async () => {
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "bootstrap-complete",
    };
    let liveEpoch: string | null = "epoch-a";
    let authorized = true;
    manager.getRuntimeEpoch = () => liveEpoch;
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      canDispatch: () => authorized,
      generateId: () => "keyed-input",
    });
    await coordinator.register(
      session,
      { emptyProject: false, mode: "created" },
      "epoch-a",
    );
    await coordinator.enqueueWithReceipt(
      session.id,
      "durable keyed request",
      "stable-request-id",
    );
    liveEpoch = null;
    session.status = "exited";
    session.ready = false;
    await coordinator.onSessionStatus(session, "epoch-a");

    expect(coordinator.ownsInput(session.id, "stable-request-id")).toBe(true);
    const replay = await coordinator.enqueueWithReceipt(
      session.id,
      "durable keyed request",
      "stable-request-id",
    );
    expect(replay.receipt.status).toBe("uncertain");
    await expect(
      coordinator.enqueueWithReceipt(
        session.id,
        "changed request",
        "stable-request-id",
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapRequestIdConflictError);
    await expect(
      coordinator.enqueueWithReceipt(
        session.id,
        "new request",
        "different-request-id",
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapDispatchForbiddenError);

    authorized = false;
    await expect(
      coordinator.enqueueWithReceipt(
        session.id,
        "durable keyed request",
        "stable-request-id",
      ),
    ).rejects.toBeInstanceOf(ProjectBootstrapDispatchForbiddenError);
    expect(submitted).toHaveLength(1);
  });

  it("fails closed on malformed current attempts, nonterminal FIFO state, and receipt reordering", async () => {
    const cases: Array<{ id: string; state: Record<string, unknown> }> = [
      {
        id: "missing-attempts",
        state: {
          schemaVersion: 3,
          metadata: {
            ...structuredClone(session.projectBootstrap!),
            bootstrap: {
              status: "failed",
              retryable: true,
              errorCode: "persistence_failed",
            },
          },
          inputs: [],
          dispatchingInputId: null,
          retryCount: 0,
          emptyProject: true,
          uncertainInputIds: [],
          uncertainInputs: [],
          receipts: [],
        },
      },
      {
        id: "nonterminal-fifo",
        state: {
          schemaVersion: 3,
          metadata: {
            ...structuredClone(session.projectBootstrap!),
            queuedInputIds: ["queued-a"],
          },
          inputs: [
            {
              id: "queued-a",
              sessionId: session.id,
              text: "must not replay",
              acceptedAt: NOW,
            },
          ],
          dispatchingInputId: null,
          retryCount: 0,
          emptyProject: true,
          attempts: [],
          uncertainInputIds: [],
          uncertainInputs: [],
          receipts: [
            {
              requestId: "queued-a-request",
              inputId: "queued-a",
              status: "queued",
              acceptedAt: NOW,
              payloadDigest: createHash("sha256")
                .update(
                  JSON.stringify({
                    schemaVersion: 1,
                    submit: true,
                    text: "must not replay",
                  }),
                )
                .digest("hex"),
            },
          ],
        },
      },
      {
        id: "receipt-after-live-fifo",
        state: {
          schemaVersion: 3,
          metadata: {
            ...structuredClone(session.projectBootstrap!),
            bootstrap: { status: "delivered", messageId: "bootstrap-done" },
            queuedInputIds: ["queued-a"],
          },
          inputs: [
            {
              id: "queued-a",
              sessionId: session.id,
              text: "must remain fenced",
              acceptedAt: NOW,
            },
          ],
          dispatchingInputId: null,
          retryCount: 0,
          emptyProject: false,
          attempts: [],
          uncertainInputIds: [],
          uncertainInputs: [],
          receipts: [
            {
              requestId: "queued-a-request",
              inputId: "queued-a",
              status: "queued",
              acceptedAt: NOW,
              payloadDigest: projectBootstrapInputDigestForTest(
                "must remain fenced",
              ),
            },
            {
              requestId: "later-request",
              inputId: "later-submitted",
              status: "completed",
              acceptedAt: NOW,
              payloadDigest: projectBootstrapInputDigestForTest("later"),
            },
          ],
        },
      },
    ];

    for (const testCase of cases) {
      const target = projectSession(`session-${testCase.id}`);
      const raw = structuredClone(testCase.state);
      const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
      metadata.projectId = PROJECT_ID;
      metadata.userId = USER_ID;
      metadata.targetSessionId = target.id;
      if (Array.isArray(raw.inputs)) {
        for (const input of raw.inputs as Array<Record<string, unknown>>) {
          input.sessionId = target.id;
        }
      }
      sessions.set(target.id, target);
      await fs.mkdir(path.dirname(stateFile(root, target.id)), {
        recursive: true,
      });
      await fs.writeFile(
        stateFile(root, target.id),
        `${JSON.stringify(raw)}\n`,
      );
      const original = await fs.readFile(stateFile(root, target.id), "utf8");
      const coordinator = new ProjectBootstrapCoordinator({
        root,
        sessionManager: manager,
      });
      await expect(
        coordinator.register(
          target,
          { emptyProject: true, mode: "boot" },
          TEST_RUNTIME_EPOCH,
        ),
      ).rejects.toThrow("project bootstrap state is unavailable");
      expect(await fs.readFile(stateFile(root, target.id), "utf8")).toBe(
        original,
      );
    }
  });

  it("emits neutral content-free lifecycle events and redacts local hook content", async () => {
    vi.useFakeTimers();
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    manager.submitInput = async () => {
      throw new Error("provider said /private/customer secret-token");
    };
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-telemetry",
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });

    expect(lifecycle.map((event) => event.name)).toEqual([
      "project_bootstrap.scheduled",
      "project_bootstrap.attempted",
    ]);
    await vi.advanceTimersByTimeAsync(300_000);
    await flushCoordinator(coordinator, session.id);
    expect(lifecycle.map((event) => event.name)).toEqual([
      "project_bootstrap.scheduled",
      "project_bootstrap.attempted",
      "project_bootstrap.failed",
    ]);
    const serializedLifecycle = JSON.stringify(lifecycle);
    expect(serializedLifecycle).not.toMatch(/planner|builder/i);
    expect(serializedLifecycle).not.toContain("Agent Studio project bootstrap");
    expect(serializedLifecycle).not.toContain("private/customer");
    expect(serializedLifecycle).not.toContain("secret-token");

    session = projectSession("session-telemetry-redaction");
    sessions.set(session.id, session);
    submitted = [];
    manager.submitInput = async (id: string, text: string) => {
      submitted.push({ sessionId: id, text, submit: true, background: true });
      return true;
    };
    const redactor = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      generateId: () => "attempt-local-only",
    });
    await redactor.register(session, { emptyProject: true, mode: "created" });
    const local = redactor.decorateLocalEvent(
      analyticsEvent(session.id, "prompt.submitted", {
        prompt: submitted[0]!.text,
        path: "/private/source.ts",
        connectorPayload: "secret connector body",
        credential: "sk-cutover-secret",
        compiledBrief: "private focused brief body",
      }),
    );
    expect(local.payload.prompt).toBe(submitted[0]!.text);
    expect(local.payload.projectBootstrapAttemptId).toBe("attempt-local-only");

    const remotePrompt = redactor.redactForTelemetry(local);
    expect(remotePrompt.agentSessionId).toBeNull();
    expect(remotePrompt.payload).toEqual({
      projectBootstrap: true,
      origin: "infrastructure",
      projectBootstrapAttemptId: "attempt-local-only",
    });
    expect(JSON.stringify(remotePrompt)).not.toContain("private/source");
    expect(JSON.stringify(remotePrompt)).not.toContain("connector body");
    expect(JSON.stringify(remotePrompt)).not.toContain("sk-cutover-secret");
    expect(JSON.stringify(remotePrompt)).not.toContain("focused brief body");

    const remoteTurn = redactor.redactForTelemetry(
      analyticsEvent(session.id, "turn.completed", {
        assistantText: "raw provider output secret",
        model: "covert-provider-channel",
        usage: { inputTokens: 10, outputTokens: 20 },
        sourceText: "customer source",
      }),
    );
    expect(remoteTurn.payload).toEqual({
      projectBootstrap: true,
      hasAssistantText: true,
      modelReported: true,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(JSON.stringify(remoteTurn)).not.toContain("provider output");
    expect(JSON.stringify(remoteTurn)).not.toContain("covert-provider");
    expect(JSON.stringify(remoteTurn)).not.toContain("customer source");

    session = projectSession("session-ordinary-after-bootstrap");
    session.projectBootstrap!.bootstrap = {
      status: "delivered",
      messageId: "message-bootstrap-complete",
    };
    sessions.set(session.id, session);
    const ordinaryEvent = analyticsEvent(session.id, "prompt.submitted", {
      prompt: "ordinary project work",
    });
    expect(redactor.redactForTelemetry(ordinaryEvent)).toEqual(ordinaryEvent);
  });

  it("closes timer and work admission without allowing a late lifecycle transition", async () => {
    vi.useFakeTimers();
    session.ready = false;
    const lifecycle: ProjectBootstrapLifecycleEvent[] = [];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      readinessTimeoutMs: 10,
      onEvent: (event) => {
        lifecycle.push(event);
      },
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    expect(
      (coordinator as unknown as { timers: Map<string, unknown> }).timers.size,
    ).toBe(1);

    await coordinator.close();
    await coordinator.close();
    expect(
      (coordinator as unknown as { timers: Map<string, unknown> }).timers.size,
    ).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(
      lifecycle.filter((event) => event.name === "project_bootstrap.failed"),
    ).toEqual([]);
    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapCoordinatorClosedError,
    );
    await expect(
      coordinator.enqueue(session.id, "must not be admitted"),
    ).rejects.toBeInstanceOf(ProjectBootstrapCoordinatorClosedError);
    await expect(
      coordinator.scheduleProject(PROJECT_ID, USER_ID),
    ).rejects.toBeInstanceOf(ProjectBootstrapCoordinatorClosedError);
  });

  it("tracks an in-flight status authorization check and clears all lifecycle state on close", async () => {
    session.ready = false;
    let blockAuthorization = false;
    let authorizationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    let releaseAuthorization!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
      readinessTimeoutMs: 60_000,
      canDispatch: async () => {
        if (!blockAuthorization) return true;
        authorizationStarted();
        await released;
        return true;
      },
    });
    await coordinator.register(session, {
      emptyProject: true,
      mode: "created",
    });
    session.ready = true;
    blockAuthorization = true;
    const status = coordinator.onSessionStatus(session);
    await started;

    let closeSettled = false;
    const closing = coordinator.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseAuthorization();
    await Promise.all([status, closing]);
    expect(closeSettled).toBe(true);

    const internals = coordinator as unknown as Record<
      string,
      Map<unknown, unknown> | Set<unknown>
    >;
    for (const key of [
      "states",
      "writes",
      "expected",
      "observedAttempts",
      "activeTurns",
      "correlationOverflow",
      "timers",
      "activeTurnTimers",
      "blockingInputRedrainTimers",
      "provisionalProjectClaims",
      "provisionalSessionClaims",
      "pendingApiPreemptions",
      "registeredSessions",
      "terminalPreemptions",
      "reportedTerminalPreemptions",
    ]) {
      expect(internals[key]?.size, key).toBe(0);
    }
  });
});

describe("projectBootstrapPrompt", () => {
  it("is evidence-first, tool-capable, role-neutral, and direct-build safe", () => {
    const prompt = projectBootstrapPrompt();

    expect(prompt).toContain("Read the current Agent Map first");
    expect(prompt).toContain("meaningfully empty");
    expect(prompt).toContain("explicit evidence");
    expect(prompt).toContain("structured Agent Map tools");
    expect(prompt).toContain("Validate before proposing");
    expect(prompt).toContain("Never guess");
    expect(prompt).toContain("prioritize");
    expect(prompt).toContain("proceed directly with implementation");
    expect(prompt).toContain("no confirmation or mode transition is required");
    expect(prompt).not.toMatch(
      /map-planner|agent-builder|planning-only|no-code/i,
    );
  });

  it("makes retries uniquely correlatable without exposing authority in the prompt", () => {
    const first = projectBootstrapPrompt(0, "attempt-1");
    const retry = projectBootstrapPrompt(1, "attempt-2");

    expect(first).not.toBe(retry);
    expect(first).toContain("Internal correlation key: attempt-1");
    expect(retry).toContain("Internal correlation key: attempt-2");
    expect(retry).toContain("automatic retry 1 of 2");
    expect(retry).toContain("Never repeat or expose this key");
    expect(first).not.toMatch(/projectId|userId|sessionId|capability|bearer/i);
  });
});
