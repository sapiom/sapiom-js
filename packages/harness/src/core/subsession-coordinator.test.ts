import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectAgentSession } from "../shared/agent-map.js";
import type {
  AnalyticsEvent,
  HarnessAdapter,
  SpawnSpec,
} from "../shared/types.js";
import type { BuildPlanStore } from "./build-plan-store.js";
import type { EventReader } from "./collector/store.js";
import { IngestCredentialRegistry } from "./ingest-credentials.js";
import { SessionManager, type PtySpawnFn } from "./session-manager.js";
import {
  SubsessionCoordinator,
  SubsessionCoordinatorError,
} from "./subsession-coordinator.js";
import { SubsessionCoordinatorStore } from "./subsession-coordinator-store.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const parentId = "parent-session-1";
const identity: ProjectAgentSession = {
  projectId,
  userId: "user-1",
  sessionId: parentId,
};

function adapter(): HarnessAdapter {
  const spec = (cwd: string): SpawnSpec => ({
    command: "fake-claude",
    args: [],
    env: {},
    cwd,
  });
  return {
    id: "claude-code",
    eventSource: "hooks",
    launch: ({ cwd }) => spec(cwd),
    resume: (_id, { cwd }) => spec(cwd),
    doctor: async () => [],
    listPastSessions: async () => [],
    canResume: async () => false,
  };
}

function fakePty() {
  const data: Array<(chunk: string) => void> = [];
  const exits: Array<(event: { exitCode: number }) => void> = [];
  const writes: string[] = [];
  return {
    pty: {
      write: vi.fn((value: string) => writes.push(String(value))),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (listener: (chunk: string) => void) => {
        data.push(listener);
        return { dispose: () => {} };
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exits.push(listener);
        return { dispose: () => {} };
      },
    } as unknown as ReturnType<PtySpawnFn>,
    writes,
  };
}

describe("SubsessionCoordinator", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "subsession-service-"));
    roots.push(root);
    const spawned: ReturnType<typeof fakePty>[] = [];
    const spawnPty = vi.fn<PtySpawnFn>(() => {
      const spawnedPty = fakePty();
      spawned.push(spawnedPty);
      return spawnedPty.pty;
    });
    const manager = new SessionManager({
      adapters: { "claude-code": adapter() },
      ingestUrl: "http://127.0.0.1:4100/ingest",
      ingestCredentials: new IngestCredentialRegistry(),
      sessionsPath: path.join(root, "sessions.json"),
      spawnPty,
      resolveAgentMapIdentity: async (_sessionId, _cwd, persisted) => persisted,
    });
    await manager.init();
    await manager.create(
      { cwd: root, harness: "claude-code" },
      {
        agentMapIdentity: (sessionId) => ({ ...identity, sessionId }),
      },
    );
    const parent = manager.list()[0]!;
    expect(parent.id).not.toBe(parentId);
    // The caller capability identity is server-derived from its real Harness
    // session ID, so use that exact value for the fixture.
    const caller = { ...identity, sessionId: parent.id };
    manager.setReady(parent.id, manager.getRuntimeEpoch(parent.id)!);
    const unsubscribe = manager.onStatusChange((session, context) => {
      if (
        session.id !== parent.id &&
        session.status === "running" &&
        !session.ready &&
        context.runtimeEpoch
      ) {
        manager.setReady(session.id, context.runtimeEpoch);
      }
    });
    const events: AnalyticsEvent[] = [];
    const eventReader: EventReader = {
      async *read(filter) {
        const ids = filter?.harnessSessionId;
        const accepted = new Set(
          typeof ids === "string" ? [ids] : ids ?? [],
        );
        for (const event of events) {
          if (accepted.size > 0 && !accepted.has(event.harnessSessionId))
            continue;
          if (filter?.types && !filter.types.includes(event.type)) continue;
          yield event;
        }
      },
      index: async () => ({ bySession: new Map(), byAgentSession: new Map() }),
    };
    const store = new SubsessionCoordinatorStore(
      path.join(root, "agent-map"),
    );
    const planningStore = {
      read: vi.fn(async () => {
        throw new Error("no focused context expected");
      }),
    } as unknown as BuildPlanStore;
    const coordinator = new SubsessionCoordinator({
      store,
      sessionManager: manager,
      planningStore,
      eventReader,
      readinessTimeoutMs: 500,
    });
    return {
      root,
      manager,
      caller,
      store,
      coordinator,
      events,
      spawnPty,
      spawned,
      unsubscribe,
    };
  }

  const request = {
    schemaVersion: 1,
    requestKey: "request-1",
    operation: {
      kind: "delegate",
      delegations: [
        {
          delegationKey: "research",
          outcome: "Implement the research slice",
          kickoffContext: "Run the focused tests.",
        },
      ],
    },
  } as const;

  it("creates one ordinary writable child and reuses it on retry", async () => {
    const { coordinator, caller, manager, spawnPty, unsubscribe } =
      await fixture();
    const first = await coordinator.execute(caller, request);
    const replay = await coordinator.execute(caller, request);
    unsubscribe();

    expect(first.results[0]).toMatchObject({
      outcome: "created",
      sessionState: "ready",
      contextState: "none",
      kickoffState: "submitted-unacknowledged",
    });
    expect(replay.results[0]).toMatchObject({
      outcome: "reused",
      sessionId: first.results[0]!.sessionId,
    });
    expect(manager.list()).toHaveLength(2);
    expect(spawnPty).toHaveBeenCalledTimes(2);
    const child = manager.get(first.results[0]!.sessionId!);
    expect(child?.agentMapIdentity).toEqual({
      projectId,
      userId: caller.userId,
      sessionId: first.results[0]!.sessionId,
    });
  });

  it("acknowledges only the exact persisted kickoff marker", async () => {
    const { coordinator, caller, manager, store, spawned, unsubscribe } =
      await fixture();
    const result = await coordinator.execute(caller, request);
    const sessionId = result.results[0]!.sessionId!;
    const prompt = spawned[1]!.writes
      .find((value) => value.includes("sapiom-project-delegation"))!;
    const event: AnalyticsEvent = {
      eventId: "event-1",
      seq: 1,
      ts: new Date().toISOString(),
      userId: caller.userId,
      tenantId: null,
      machineId: "machine-1",
      harnessSessionId: sessionId,
      agentSessionId: null,
      harness: "claude-code",
      type: "prompt.submitted",
      payload: { prompt },
    };
    await coordinator.onEventPersisted(
      event,
      manager.getRuntimeEpoch(sessionId)!,
    );
    const aggregate = await store.read(projectId);
    unsubscribe();

    expect(aggregate.bindings[0]!.deliveries[0]!.state).toBe("acknowledged");
  });

  it("fails closed when the caller identity is not its trusted session scope", async () => {
    const { coordinator, caller, manager, unsubscribe } = await fixture();
    await expect(
      coordinator.execute({ ...caller, projectId: "project_00000000-0000-4000-8000-000000000099" }, request),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SubsessionCoordinatorError>>({
        detail: expect.objectContaining({ code: "capability_scope_mismatch" }),
      }),
    );
    unsubscribe();
    expect(manager.list()).toHaveLength(1);
  });
});
