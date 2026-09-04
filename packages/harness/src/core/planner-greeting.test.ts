import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
} from "./session-manager.js";
import {
  ProjectBootstrapCoordinator as ProjectBootstrapCoordinatorImpl,
  ProjectBootstrapCoordinatorClosedError,
  ProjectBootstrapDispatchForbiddenError,
  ProjectBootstrapRetryUnavailableError,
  projectBootstrapPrompt,
  type ProjectBootstrapCoordinatorOptions,
} from "./planner-greeting.js";

const activeCoordinators = new Set<ProjectBootstrapCoordinatorImpl>();

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
  }>;
  uncertainInputIds?: string[];
  uncertainInputs?: Array<{
    id: string;
    sessionId: string;
    text: string;
    acceptedAt: string;
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
      ) => {
        if (canWrite && !(await canWrite())) return false;
        submitted.push({ sessionId: id, text, submit, background });
        return true;
      },
      preemptBackgroundInput: () => false,
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

  it("durably schedules one project lifecycle and atomically claims its first ordinary session", async () => {
    const first = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });

    await expect(first.scheduleProject(PROJECT_ID, USER_ID)).resolves.toBe(
      true,
    );
    await expect(first.scheduleProject(PROJECT_ID, USER_ID)).resolves.toBe(
      false,
    );

    const restarted = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await expect(
      restarted.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(true);

    const claimed = await restarted.claimProject(session.agentMapIdentity!);
    expect(claimed).toEqual({
      projectId: PROJECT_ID,
      userId: USER_ID,
      targetSessionId: session.id,
      bootstrap: { status: "pending" },
      queuedInputIds: [],
    });
    session.projectBootstrap = claimed!;
    await expect(
      restarted.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(false);

    const second = projectSession("session-2");
    sessions.set(second.id, second);
    await expect(
      restarted.claimProject(second.agentMapIdentity!),
    ).resolves.toBeNull();

    const intent = JSON.parse(
      await fs.readFile(
        path.join(root, "projects", `${PROJECT_ID}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(intent).toMatchObject({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      userId: USER_ID,
      targetSessionId: session.id,
      status: "claimed",
    });
    expect(JSON.stringify(intent)).not.toContain(session.cwd);
  });

  it("does not let a concurrent create steal a claim before SessionManager publishes its session", async () => {
    sessions.delete(session.id);
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);

    const first = await coordinator.claimProject(session.agentMapIdentity!);
    expect(first?.targetSessionId).toBe(session.id);

    const racing = projectSession("session-racing-create");
    expect(await coordinator.claimProject(racing.agentMapIdentity!)).toBeNull();
    await expect(
      coordinator.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(false);

    // A proven pre-spawn failure releases only the volatile claim. The durable
    // project intent remains available for a replacement ordinary session.
    await coordinator.releaseSessionClaim(session.id);
    expect(
      await coordinator.claimProject(racing.agentMapIdentity!),
    ).toMatchObject({ targetSessionId: racing.id });
  });

  it("rejects a foreign project-intent claimant and can recover a missing claimed target", async () => {
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);
    await expect(
      coordinator.claimProject({
        ...session.agentMapIdentity!,
        userId: "foreign-user",
      }),
    ).rejects.toBeInstanceOf(ProjectBootstrapDispatchForbiddenError);

    const first = await coordinator.claimProject(session.agentMapIdentity!);
    session.projectBootstrap = first!;
    await coordinator.releaseSessionClaim(session.id);
    sessions.delete(session.id);
    const replacement = projectSession("session-replacement");
    sessions.set(replacement.id, replacement);

    const recovered = await coordinator.claimProject(
      replacement.agentMapIdentity!,
    );
    expect(recovered?.targetSessionId).toBe(replacement.id);
    expect(recovered?.bootstrap).toEqual({ status: "pending" });
  });

  it("preserves a failed pre-spawn tombstone while letting the next ordinary session claim bootstrap", async () => {
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);
    const first = await coordinator.claimProject(session.agentMapIdentity!);
    session.projectBootstrap = first!;
    session.status = "exited";
    session.agentSessionId = null;

    await expect(
      coordinator.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(true);

    const replacement = projectSession("session-replacement");
    sessions.set(replacement.id, replacement);
    const recovered = await coordinator.claimProject(
      replacement.agentMapIdentity!,
    );

    expect(sessions.get(session.id)).toBe(session);
    expect(recovered).toMatchObject({
      projectId: PROJECT_ID,
      targetSessionId: replacement.id,
      bootstrap: { status: "pending" },
    });
  });

  it("refuses replacement when an abandoned target still owns durable input", async () => {
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);
    const first = await coordinator.claimProject(session.agentMapIdentity!);
    session.projectBootstrap = first!;
    await writeState(root, session.id, {
      schemaVersion: 2,
      metadata: {
        ...structuredClone(first!),
        bootstrap: { status: "skipped", reason: "user-proceeded" },
        queuedInputIds: ["durable-user-input"],
      },
      inputs: [
        {
          id: "durable-user-input",
          sessionId: session.id,
          text: "preserve this exact request",
          acceptedAt: NOW,
        },
      ],
      dispatchingInputId: null,
      retryCount: 0,
      emptyProject: true,
      attempts: [],
    });
    session.status = "exited";
    session.agentSessionId = null;

    await expect(
      coordinator.needsProjectSession(PROJECT_ID, USER_ID),
    ).resolves.toBe(false);
    const replacement = projectSession("session-replacement-refused");
    sessions.set(replacement.id, replacement);
    await expect(
      coordinator.claimProject(replacement.agentMapIdentity!),
    ).resolves.toBeNull();

    expect((await readState(root, session.id)).inputs).toEqual([
      expect.objectContaining({
        id: "durable-user-input",
        sessionId: session.id,
        text: "preserve this exact request",
      }),
    ]);
    const intent = JSON.parse(
      await fs.readFile(
        path.join(root, "projects", `${PROJECT_ID}.json`),
        "utf8",
      ),
    ) as { targetSessionId: string };
    expect(intent.targetSessionId).toBe(session.id);
  });

  it("records real input already pending at claim time as higher priority", async () => {
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });
    await coordinator.scheduleProject(PROJECT_ID, USER_ID);

    const claimed = await coordinator.claimProject(
      session.agentMapIdentity!,
      true,
    );

    expect(claimed?.bootstrap).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
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
      { attemptId: "attempt-1", retryOrdinal: 0, status: "retired" },
      { attemptId: "attempt-2", retryOrdinal: 1, status: "completed" },
    ]);
    await expect(coordinator.retry(session.id)).rejects.toBeInstanceOf(
      ProjectBootstrapRetryUnavailableError,
    );
  });

  it("holds user input behind an uncertain timed-out turn and drains it once after process restart", async () => {
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
    ).resolves.toMatchObject({ queuedInputIds: ["input-after-restart"] });
    expect(submitted.map((entry) => entry.text)).toEqual([bootstrapPrompt]);

    // Server restart ends the old PTY before this exact persisted session is
    // resumed. That process boundary, unlike the timeout itself, proves the
    // uncertain turn cannot overlap the durable FIFO on the replacement PTY.
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
      },
    ]);
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        name: "project_bootstrap.recovered",
        sessionId: session.id,
      }),
    );
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
      })}\n`,
    );

    const coordinator = new ProjectBootstrapCoordinator({
      root,
      legacyRoot,
      sessionManager: manager,
    });
    await coordinator.register(session, { emptyProject: true, mode: "boot" });

    const migrated = await readState(root, session.id);
    expect(migrated).toMatchObject({
      schemaVersion: 2,
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
    await coordinator.enqueue(session.id, "second user request");
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
    ) => {
      if (background) {
        announceStaged();
        await released;
        if (canWrite && !(await canWrite())) {
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
        background: undefined,
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
    ) => {
      if (preemptOnce) {
        preemptOnce = false;
        coordinator.onTerminalInput(id);
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

  it("fails closed on malformed primary state without deleting, replacing, or quarantining it", async () => {
    const directory = path.join(root, session.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      stateFile(root, session.id),
      "{private-undelivered-input",
    );
    session.projectBootstrap!.queuedInputIds = ["unknown-undelivered-input"];
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });

    await expect(
      coordinator.register(session, { emptyProject: true, mode: "boot" }),
    ).rejects.toThrow("project bootstrap state is unavailable");
    expect(await fs.readFile(stateFile(root, session.id), "utf8")).toBe(
      "{private-undelivered-input",
    );
    expect(await fs.readdir(directory)).toEqual(["input-queue.json"]);
    expect(session.projectBootstrap?.queuedInputIds).toEqual([
      "unknown-undelivered-input",
    ]);
  });

  it("rejects a session identity that could escape the bootstrap root", async () => {
    session = projectSession("../escape");
    sessions = new Map([[session.id, session]]);
    const coordinator = new ProjectBootstrapCoordinator({
      root,
      sessionManager: manager,
    });

    await expect(
      coordinator.register(session, { emptyProject: true, mode: "created" }),
    ).rejects.toThrow("project bootstrap state is unavailable");
    await expect(fs.readdir(root)).resolves.toEqual([]);
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
      errorCode: "session_exited",
    });

    session = projectSession("session-injection-failure");
    sessions.set(session.id, session);
    manager.submitInput = async () => {
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

  it("emits neutral content-free lifecycle events and redacts local hook content", async () => {
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
