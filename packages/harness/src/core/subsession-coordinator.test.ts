import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectAgentSession } from "../shared/agent-map.js";
import type { AgentMapGraph, AgentMapVersion, AgentMapVersionId, PlanNodeId } from "../shared/agent-map.js";
import {
  computeAgentMapVersionRecordDigest,
  computeGraphContentDigest,
} from "../shared/agent-map-canonical.js";
import type {
  BuildPlanAssignmentIntent,
  ProjectBuildPlanId,
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionId,
} from "../shared/build-plan.js";
import type {
  AnalyticsEvent,
  HarnessAdapter,
  SpawnSpec,
} from "../shared/types.js";
import type { BuildPlanStore } from "./build-plan-store.js";
import {
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";
import { compileCanonicalWorkstreamBriefs } from "./agent-brief-compiler.js";
import { createEmptyProjectPlanningAggregate } from "./agent-map-aggregate-migration.js";
import type { EventReader } from "./collector/store.js";
import { IngestCredentialRegistry } from "./ingest-credentials.js";
import { SessionManager, type PtySpawnFn } from "./session-manager.js";
import {
  SubsessionCoordinator,
  SubsessionCoordinatorError,
} from "./subsession-coordinator.js";
import {
  SubsessionCoordinatorStore,
  SubsessionCoordinatorStoreError,
} from "./subsession-coordinator-store.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const parentId = "parent-session-1";
const identity: ProjectAgentSession = {
  projectId,
  userId: "user-1",
  sessionId: parentId,
};
const plannedAgentId = "node_018f0000-0000-7000-8000-000000000010" as PlanNodeId;
const assignmentId = "work_018f0000-0000-7000-8000-000000000020" as BuildPlanAssignmentIntent["id"];

function focusedPlanningAggregate() {
  const graph: AgentMapGraph = {
    nodes: [{ id: plannedAgentId, kind: "agent", name: "Research", purpose: "Rank stocks",
      ownerAgentId: null, contractRefs: ["ResearchReport"] }],
    relationships: [],
  };
  const contentDigest = computeGraphContentDigest(graph);
  const mapBase = {
    schemaVersion: 1 as const, projectId,
    versionId: "mapv_018f0000-0000-7000-8000-000000000001" as AgentMapVersionId,
    version: 1, parentVersionId: null, changeKind: "created" as const,
    restoredFromVersionId: null, graph, contentDigest,
    authoredBy: { userId: "user-1", sessionId: parentId },
    createdAt: "2026-09-04T00:00:00.000Z",
    origin: { kind: "request" as const, requestDigest: `sha256:${"1".repeat(64)}`,
      operationIds: [], touchKeys: [] },
  };
  const map: AgentMapVersion = { ...mapBase, recordDigest: computeAgentMapVersionRecordDigest(mapBase) };
  const content = {
    outcome: "Publish ranked stocks", nonGoals: [], milestones: [], sequenceGates: [],
    sharedConstraints: [], repositoryIntents: [], integrationCriteria: [], acceptanceCriteria: [],
    decisions: [], unresolvedDecisions: [], risks: [],
    assignments: [{ id: assignmentId, plannedAgentId, briefId: null,
      mission: "Rank ten stocks", scope: ["Research"], nonGoals: [], dependencies: [] }],
  };
  const semanticDigest = computeBuildPlanSemanticDigest(content);
  const planBase = {
    schemaVersion: 1 as const, projectId,
    planId: "plan_018f0000-0000-7000-8000-000000000001" as ProjectBuildPlanId,
    versionId: "planv_018f0000-0000-7000-8000-000000000001" as ProjectBuildPlanVersionId,
    version: 1, parentVersionId: null, changeKind: "created" as const,
    restoredFromVersionId: null,
    map: { projectId, versionId: map.versionId, contentDigest: map.contentDigest },
    content, semanticDigest, authoredBy: { userId: "user-1", sessionId: parentId },
    createdAt: "2026-09-04T00:00:01.000Z",
    origin: { kind: "request" as const, requestDigest: `sha256:${"2".repeat(64)}`,
      operationIds: [], touchKeys: [] },
  };
  const plan: ProjectBuildPlanVersion = {
    ...planBase,
    recordDigest: computeBuildPlanRecordDigest(planBase),
  };
  const brief = compileCanonicalWorkstreamBriefs({
    projectId, map, plan, mapHistory: [map], planHistory: [plan], previousBriefs: [],
  }).briefs[0]!.brief;
  const aggregate = createEmptyProjectPlanningAggregate(projectId, "2026-09-04T00:00:00.000Z");
  aggregate.mapVersions.push(map);
  aggregate.buildPlanVersions.push(plan);
  aggregate.briefVersionsById[brief.briefId] = [brief];
  aggregate.current.map = {
    projectId, versionId: map.versionId, contentDigest: map.contentDigest,
  };
  aggregate.current.buildPlan = {
    projectId, planId: plan.planId, versionId: plan.versionId,
    semanticDigest: plan.semanticDigest,
  };
  aggregate.current.briefsByScope[brief.scopeKey] = {
    scopeKey: brief.scopeKey, focusScope: brief.focusScope, briefId: brief.briefId,
    status: "active",
    version: { projectId, briefId: brief.briefId, versionId: brief.versionId,
      semanticDigest: brief.semanticDigest },
  };
  return { aggregate, brief };
}

function adapter(
  resumable = false,
  eventSource: HarnessAdapter["eventSource"] = "hooks",
): HarnessAdapter {
  const spec = (cwd: string): SpawnSpec => ({
    command: "fake-claude",
    args: [],
    env: {},
    cwd,
  });
  return {
    id: "claude-code",
    eventSource,
    launch: ({ cwd }) => spec(cwd),
    resume: (_id, { cwd }) => spec(cwd),
    doctor: async () => [],
    listPastSessions: async () => [],
    canResume: async () => resumable,
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
    emitExit: (exitCode = 0) =>
      exits.forEach((listener) => listener({ exitCode })),
  };
}

describe("SubsessionCoordinator", () => {
  const roots: string[] = [];
  const managers: SessionManager[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(managers.splice(0).map((manager) => manager.flush()));
    await Promise.all(
      roots.splice(0).map((root) =>
        fs.rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function fixture(
    resumable = false,
    childIdentityState?: "ready" | "ambiguous",
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "subsession-service-"));
    roots.push(root);
    const spawned: ReturnType<typeof fakePty>[] = [];
    const launchContexts: Array<Parameters<NonNullable<ConstructorParameters<typeof SessionManager>[0]["buildLaunchOpts"]>>[2]> = [];
    const spawnPty = vi.fn<PtySpawnFn>(() => {
      const spawnedPty = fakePty();
      spawned.push(spawnedPty);
      return spawnedPty.pty;
    });
    const closeStore: { current?: SubsessionCoordinatorStore } = {};
    const manager = new SessionManager({
      adapters: {
        "claude-code": adapter(
          resumable,
          childIdentityState ? "transcript-tail" : "hooks",
        ),
      },
      ingestUrl: "http://127.0.0.1:4100/ingest",
      ingestCredentials: new IngestCredentialRegistry(),
      sessionsPath: path.join(root, "sessions.json"),
      spawnPty,
      buildLaunchOpts: (_sessionId, _request, context) => {
        launchContexts.push(context);
        return {};
      },
      onSubsessionUserClosed: async (marker) => {
        await closeStore.current?.closeOwnedBinding(marker);
      },
      resolveAgentMapIdentity: async (_sessionId, _cwd, persisted) => persisted,
    });
    managers.push(manager);
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
        if (childIdentityState)
          manager.setAdapterIdentityState(
            session.id,
            context.runtimeEpoch,
            childIdentityState,
          );
      }
    });
    const events: AnalyticsEvent[] = [];
    const recordedTurnSessionIds = new Set<string>();
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
      index: async () => ({
        bySession: new Map(
          [...recordedTurnSessionIds].map((sessionId) => [
            sessionId,
            {
              harnessSessionId: sessionId,
              spans: [],
              eventCount: 1,
              turnCount: 1,
              agentSessionIds: [],
              harness: "claude-code" as const,
              firstTs: null,
              lastTs: null,
            },
          ]),
        ),
        byAgentSession: new Map(),
      }),
    };
    const store = new SubsessionCoordinatorStore(
      path.join(root, "agent-map"),
    );
    closeStore.current = store;
    const telemetry: unknown[] = [];
    const planningStore = {
      read: vi.fn(async () => {
        throw new Error("no focused context expected");
      }),
    } as unknown as BuildPlanStore;
    const newCoordinator = (ownerId?: string) => new SubsessionCoordinator({
      store, sessionManager: manager, planningStore, eventReader,
      readinessTimeoutMs: 500,
      onEvent: (event) => {
        telemetry.push(event);
      },
      ...(ownerId ? { ownerId } : {}),
    });
    const coordinator = newCoordinator();
    return {
      root,
      manager,
      caller,
      store,
      coordinator,
      newCoordinator,
      planningStore,
      events,
      recordedTurnSessionIds,
      spawnPty,
      spawned,
      launchContexts,
      telemetry,
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
    const { coordinator, caller, manager, spawnPty, telemetry, unsubscribe } =
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
    expect(telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "subsession.requested", projectId }),
      expect.objectContaining({ name: "subsession.created", projectId }),
      expect.objectContaining({ name: "subsession.ready", projectId }),
      expect.objectContaining({ name: "subsession.kickoff_submitted", projectId }),
    ]));
    expect(JSON.stringify(telemetry)).not.toContain("Implement the research slice");
    expect(JSON.stringify(telemetry)).not.toContain("Run the focused tests");
  });

  it("converges independent coordinator instances on one child process", async () => {
    const { coordinator, newCoordinator, caller, manager, spawnPty, unsubscribe } =
      await fixture();
    const other = newCoordinator("other-coordinator");
    const [first, second] = await Promise.all([
      coordinator.execute(caller, request),
      other.execute(caller, request),
    ]);
    unsubscribe();

    expect(first.results[0]!.sessionId).toBe(second.results[0]!.sessionId);
    expect([first.results[0]!.outcome, second.results[0]!.outcome]).toEqual(
      expect.arrayContaining(["created", "already-running"]),
    );
    expect(manager.list()).toHaveLength(2);
    expect(spawnPty).toHaveBeenCalledTimes(2);
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

  it("never fresh-restarts an exited child after kickoff delivery becomes uncertain", async () => {
    const { coordinator, caller, manager, store, spawned, spawnPty, unsubscribe } =
      await fixture();
    const first = await coordinator.execute(caller, request);
    const childId = first.results[0]!.sessionId!;
    spawned[1]!.emitExit(1);
    await manager.flush();

    const retried = await coordinator.execute(caller, request);
    const aggregate = await store.read(projectId);
    unsubscribe();

    expect(retried.results[0]).toMatchObject({
      outcome: "failed",
      sessionId: childId,
      kickoffState: "uncertain",
      error: { code: "session_unreachable", retryable: false },
    });
    expect(spawnPty).toHaveBeenCalledTimes(2);
    expect(aggregate.bindings[0]!.deliveries[0]!.state).toBe("uncertain");
  });

  it("resumes an exited coordinator-owned vendor conversation under the same Harness id", async () => {
    const { coordinator, caller, manager, spawned, spawnPty, unsubscribe } =
      await fixture(true);
    const first = await coordinator.execute(caller, request);
    const childId = first.results[0]!.sessionId!;
    const runtime = manager.getRuntimeEpoch(childId)!;
    await manager.setAgentSessionId(childId, "agent-child-1", "startup", runtime);
    spawned[1]!.emitExit(0);
    await manager.flush();

    const retried = await coordinator.execute(caller, request);
    unsubscribe();

    expect(retried.results[0]).toMatchObject({
      outcome: "reused",
      sessionId: childId,
      sessionState: "ready",
      kickoffState: "uncertain",
    });
    expect(manager.list().filter(({ id }) => id === childId)).toHaveLength(1);
    expect(spawnPty).toHaveBeenCalledTimes(3);
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

  it("preserves bounded codec codes and issues for callers", async () => {
    const { coordinator, caller, unsubscribe } = await fixture();
    await expect(
      coordinator.execute(caller, {
        schemaVersion: 2,
        requestKey: "unsupported",
        operation: { kind: "delegate", delegations: [] },
      }),
    ).rejects.toMatchObject({
      detail: {
        code: "unsupported_schema",
        retryable: false,
        recovery: "correct",
        issues: [{ path: "schemaVersion", code: "unsupported_schema" }],
      },
    });
    await expect(
      coordinator.execute(caller, {
        schemaVersion: 1,
        requestKey: "utf8-overflow",
        operation: {
          kind: "delegate",
          delegations: [
            {
              delegationKey: "research",
              outcome: "界".repeat(2_000),
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      detail: {
        code: "invalid_request",
        retryable: false,
        recovery: "correct",
        issues: [
          {
            path: "operation.delegations[0]",
            code: "invalid_delegation",
          },
        ],
      },
    });
    unsubscribe();
  });

  it("does not advise retry or request reduction for permanent history exhaustion", async () => {
    const { coordinator, caller, store, unsubscribe } = await fixture();
    vi.spyOn(store, "reserveDelegations").mockRejectedValueOnce(
      new SubsessionCoordinatorStoreError("history_quota_exceeded"),
    );
    await expect(coordinator.execute(caller, request)).rejects.toMatchObject({
      detail: {
        code: "capacity_exceeded",
        retryable: false,
        recovery: "none",
      },
    });
    unsubscribe();
  });

  it("writes no kickoff when adapter identity correlation is ambiguous", async () => {
    const { coordinator, caller, spawned, unsubscribe } = await fixture(
      false,
      "ambiguous",
    );
    const result = await coordinator.execute(caller, request);
    unsubscribe();

    expect(result.results[0]).toMatchObject({
      outcome: "failed",
      sessionState: "awaiting-ready",
      kickoffState: "pending",
      error: {
        code: "adapter_identity_ambiguous",
        retryable: false,
        recovery: "inspect_session",
      },
    });
    expect(spawned[1]!.writes).toEqual([]);
  });

  it("reports recorded-turn fresh restart rejection as terminal", async () => {
    const {
      coordinator,
      caller,
      manager,
      recordedTurnSessionIds,
      spawned,
      unsubscribe,
    } = await fixture(false, "ambiguous");
    const first = await coordinator.execute(caller, request);
    const childId = first.results[0]!.sessionId!;
    recordedTurnSessionIds.add(childId);
    spawned[1]!.emitExit(1);
    await manager.flush();

    const retried = await coordinator.execute(caller, request);
    unsubscribe();

    expect(retried.results[0]).toMatchObject({
      outcome: "failed",
      sessionId: childId,
      kickoffState: "pending",
      error: {
        code: "session_restart_failed",
        retryable: false,
        recovery: "inspect_session",
      },
    });
  });

  it("removes a user-closed child from live coordinator capacity", async () => {
    const { coordinator, caller, manager, store, spawned, unsubscribe } =
      await fixture();
    const created = await coordinator.execute(caller, request);
    const childId = created.results[0]!.sessionId!;

    const closing = manager.close(childId);
    spawned[1]!.emitExit(0);
    await closing;
    const aggregate = await store.read(projectId);
    unsubscribe();

    expect(aggregate.bindings[0]).toMatchObject({
      sessionId: childId,
      sessionState: "closed",
      runtime: null,
    });
  });

  it("delivers one exact brief overlay and surfaces later staleness without restricting the child", async () => {
    const { aggregate, brief } = focusedPlanningAggregate();
    const {
      coordinator,
      caller,
      manager,
      planningStore,
      spawned,
      launchContexts,
      unsubscribe,
    } = await fixture();
    vi.mocked(planningStore.read).mockResolvedValue(aggregate);
    const focusedRequest = {
      schemaVersion: 1,
      requestKey: "focused-request",
      operation: {
        kind: "delegate",
        delegations: [{
          delegationKey: "focused-research",
          outcome: "Implement the focused research slice",
          focus: {
            kind: "brief",
            brief: {
              projectId,
              briefId: brief.briefId,
              versionId: brief.versionId,
              semanticDigest: brief.semanticDigest,
            },
          },
        }],
      },
    } as const;

    const first = await coordinator.execute(caller, focusedRequest);
    const replay = await coordinator.execute(caller, focusedRequest);
    const childId = first.results[0]!.sessionId!;
    const kickoffWrites = spawned[1]!.writes.filter((value) =>
      value.includes("sapiom-project-delegation"),
    );
    expect(first.results[0]).toMatchObject({
      outcome: "created",
      contextState: "current",
      sessionState: "ready",
    });
    expect(replay.results[0]).toMatchObject({
      outcome: "reused",
      sessionId: childId,
    });
    expect(kickoffWrites).toHaveLength(1);
    expect(launchContexts[1]?.focusedContext).toContain("focused-project-context");
    expect(launchContexts[1]?.focusedContext).toContain(brief.versionId);
    expect(kickoffWrites[0]).not.toContain("focused-project-context");

    aggregate.current.briefsByScope[brief.scopeKey] = {
      ...aggregate.current.briefsByScope[brief.scopeKey]!,
      status: "retired",
    };
    const stale = await coordinator.execute(caller, focusedRequest);
    unsubscribe();

    expect(stale.results[0]).toMatchObject({
      outcome: "failed",
      sessionId: childId,
      contextState: "stale",
      error: { code: "context_stale", recovery: "refresh_context" },
    });
    expect(manager.get(childId)).toMatchObject({
      status: "running",
      agentMapIdentity: { projectId, sessionId: childId },
    });
    expect(spawned[1]!.writes.filter((value) =>
      value.includes("sapiom-project-delegation"),
    )).toHaveLength(1);
  });
});
