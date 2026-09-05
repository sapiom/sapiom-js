import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DraftRef,
  MapProposalId,
  PlanNodeId,
  PlanRelationshipId,
  ProjectAgentSession,
  ProposalBatchRequest,
  ProposalOperationId,
} from "../shared/agent-map.js";
import {
  AgentMapProposalQuotaError,
  AgentMapProposalService,
  AgentMapProposalValidationError,
  type AgentMapPermanentIdAllocator,
} from "./agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";

class Ids implements AgentMapPermanentIdAllocator {
  private value = 1;
  private next(prefix: string) {
    return `${prefix}_00000000-0000-7000-8000-${String(this.value++).padStart(12, "0")}`;
  }
  allocateNodeId = () => this.next("node") as PlanNodeId;
  allocateRelationshipId = () => this.next("rel") as PlanRelationshipId;
  allocateProposalId = () => this.next("proposal") as MapProposalId;
  allocateOperationId = () => this.next("operation") as ProposalOperationId;
}

const identity = (sessionId: string): ProjectAgentSession => ({
  projectId,
  userId: "user-1",
  sessionId,
});

const addNode = (
  requestId: string,
  expectedVersion: number,
  proposalId: MapProposalId | null,
  draftRef = requestId,
): ProposalBatchRequest => ({
  schemaVersion: 1,
  proposalId,
  expectedVersion,
  requestId,
  operations: [
    {
      kind: "add-node",
      draftRef: draftRef as DraftRef,
      node: {
        kind: "agent",
        name: draftRef,
        purpose: "Research",
        ownerAgent: null,
        contractRefs: [],
      },
    },
  ],
});

describe("AgentMapProposalService", () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    ),
  );

  async function fixture(receiptRetentionLimit?: number, versionHistoryLimit?: number, operationHistoryLimit?: number) {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-map-proposal-"),
    );
    roots.push(root);
    const accepted = vi.fn();
    const outcomes = vi.fn();
    return {
      root,
      accepted,
      outcomes,
      service: new AgentMapProposalService(new AgentMapWorkspaceStore(root), {
        allocator: new Ids(),
        now: () => new Date("2026-09-02T12:00:00.000Z"),
        onAccepted: accepted,
        onOutcome: outcomes,
        ...(receiptRetentionLimit === undefined
          ? {}
          : { receiptRetentionLimit }),
        ...(versionHistoryLimit === undefined
          ? {}
          : { versionHistoryLimit }),
        ...(operationHistoryLimit === undefined ? {} : { operationHistoryLimit }),
      }),
    };
  }

  it("atomically persists one attributed proposal and survives restart", async () => {
    const { root, service, accepted } = await fixture();
    const result = await service.propose(
      identity("session-1"),
      addNode("request-1", 0, null),
    );
    const restarted = new AgentMapProposalService(
      new AgentMapWorkspaceStore(root),
    );
    const snapshot = await restarted.read(projectId);

    expect(snapshot.workspace).toMatchObject({
      recordVersion: 2,
      activeProposalId: result.proposalId,
    });
    expect(snapshot.proposal).toMatchObject({
      id: result.proposalId,
      version: 1,
    });
    expect(snapshot.proposal?.history[0]?.actor).toEqual({
      userId: "user-1",
      sessionId: "session-1",
    });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("returns the durable original receipt without duplicating or rebroadcasting", async () => {
    const { service, accepted, outcomes } = await fixture();
    const request = addNode("request-1", 0, null);
    if (request.operations[0]?.kind === "add-node")
      request.operations[0].node.contractRefs = ["z-contract", "a-contract"];
    const first = await service.propose(identity("session-1"), request);
    const reordered = structuredClone(request);
    if (reordered.operations[0]?.kind === "add-node")
      reordered.operations[0].node.contractRefs.reverse();
    await expect(
      service.propose(identity("session-1"), reordered),
    ).resolves.toEqual(first);
    expect((await service.read(projectId)).proposal?.history).toHaveLength(1);
    expect(accepted).toHaveBeenCalledOnce();
    expect(outcomes.mock.calls.map(([event]) => event.name)).toEqual([
      "agent_map.proposal.accepted",
      "agent_map.proposal.replayed",
    ]);
    expect(Object.keys(outcomes.mock.calls[0]![0]).sort()).toEqual([
      "latencyMs",
      "name",
      "operationCount",
      "projectId",
      "sessionId",
    ]);
  });

  it("records an accepted semantic no-op for replay without appending a duplicate map version", async () => {
    const { root, service, accepted } = await fixture();
    const first = await service.propose(identity("session-1"), addNode("request-1", 0, null));
    const nodeId = Object.values(first.allocatedNodeIds)[0]!;
    const noOp = await service.propose(identity("session-1"), {
      schemaVersion: 1,
      proposalId: first.proposalId,
      expectedVersion: 1,
      requestId: "request-no-op",
      operations: [{ kind: "update-node", nodeId, changes: { name: "request-1" } }],
    });
    const aggregate = await new AgentMapWorkspaceStore(root).readAggregate(projectId);

    expect(noOp.version).toBe(2);
    expect(aggregate.mapOperationHistory).toHaveLength(2);
    expect(aggregate.mapVersions).toHaveLength(1);
    expect(aggregate.requestReceipts).toHaveLength(2);
    await expect(service.propose(identity("session-1"), {
      schemaVersion: 1,
      proposalId: first.proposalId,
      expectedVersion: 1,
      requestId: "request-no-op",
      operations: [{ kind: "update-node", nodeId, changes: { name: "request-1" } }],
    })).resolves.toEqual(noOp);
    expect(accepted).toHaveBeenCalledTimes(2);
  });

  it("fails map history quota before mutation with a bounded terminal error", async () => {
    const { root, service, accepted, outcomes } = await fixture(undefined, 1);
    const first = await service.propose(identity("session-1"), addNode("request-1", 0, null));
    const before = await new AgentMapWorkspaceStore(root).readAggregate(projectId);

    await expect(service.propose(identity("session-1"), addNode("request-2", 1, first.proposalId)))
      .rejects.toBeInstanceOf(AgentMapProposalQuotaError);
    expect(await new AgentMapWorkspaceStore(root).readAggregate(projectId)).toEqual(before);
    expect(accepted).toHaveBeenCalledOnce();
    expect(outcomes.mock.calls.at(-1)?.[0]).toMatchObject({
      name: "agent_map.proposal.quota_exceeded",
      operationCount: 1,
    });
  });

  it("rejects batches that exceed the operation history quota without losing existing replays", async () => {
    const { root, service, accepted } = await fixture(undefined, undefined, 2);
    const firstRequest = addNode("request-1", 0, null);
    const first = await service.propose(identity("session-1"), firstRequest);
    const before = await new AgentMapWorkspaceStore(root).readAggregate(projectId);
    const next = addNode("request-2", 1, first.proposalId);
    next.operations.push(...addNode("request-3", 1, first.proposalId).operations);
    await expect(service.propose(identity("session-1"), next)).rejects.toMatchObject({
      code: "quota_exceeded", resource: "map_operations",
    });
    expect(await new AgentMapWorkspaceStore(root).readAggregate(projectId)).toEqual(before);
    await expect(service.propose(identity("session-1"), firstRequest)).resolves.toEqual(first);
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("bounds compact receipts and fails closed after exact replay retention", async () => {
    const { root, service, accepted } = await fixture(1);
    const firstRequest = addNode("request-1", 0, null);
    const first = await service.propose(identity("session-1"), firstRequest);
    const secondRequest = addNode("request-2", 1, first.proposalId);
    const second = await service.propose(identity("session-1"), secondRequest);
    const aggregate = await new AgentMapWorkspaceStore(root).readAggregate(
      projectId,
    );

    expect(aggregate.requestReceipts).toEqual([
      expect.objectContaining({
        userId: "user-1",
        sessionId: "session-1",
        requestId: "request-2",
        operation: "map",
        result: expect.objectContaining({ version: 2 }),
      }),
    ]);
    expect(aggregate.requestTombstones).toEqual([
      expect.objectContaining({ requestId: "request-1", operation: "map" }),
    ]);
    await expect(
      service.propose(identity("session-1"), firstRequest),
    ).rejects.toMatchObject({
      conflict: { code: "request_id_expired", recovery: "new_request" },
    });
    await expect(
      service.propose(identity("session-1"), secondRequest),
    ).resolves.toEqual(second);
    expect(accepted).toHaveBeenCalledTimes(2);
    expect((await service.read(projectId)).proposal?.version).toBe(2);
  });

  it("rejects actor identities that the durable codec cannot read", async () => {
    const { service } = await fixture();
    await expect(
      service.propose(
        identity("session\u007f1"),
        addNode("request-1", 0, null),
      ),
    ).rejects.toBeInstanceOf(AgentMapProposalValidationError);
    expect(await service.read(projectId)).toMatchObject({ proposal: null });
  });

  it("rejects changed reuse of a session request ID", async () => {
    const { service } = await fixture(1);
    await service.propose(identity("session-1"), addNode("request-1", 0, null));
    await expect(
      service.propose(
        identity("session-1"),
        addNode("request-1", 0, null, "different"),
      ),
    ).rejects.toMatchObject({
      conflict: { code: "request_id_reused", recovery: "new_request" },
    });
  });

  it("rebases disjoint stale additions and rejects overlapping stale edits", async () => {
    const { service } = await fixture(1);
    const first = await service.propose(
      identity("session-1"),
      addNode("request-1", 0, null),
    );
    const second = await service.propose(
      identity("session-1"),
      addNode("request-2", 1, first.proposalId),
    );
    await service.propose(
      identity("session-2"),
      addNode("request-3", 1, first.proposalId),
    );
    const nodeId = second.allocatedNodeIds["request-2" as DraftRef]!;
    const edit = (session: string, name: string): ProposalBatchRequest => ({
      schemaVersion: 1,
      proposalId: first.proposalId,
      expectedVersion: 3,
      requestId: session,
      operations: [{ kind: "update-node", nodeId, changes: { name } }],
    });
    await service.propose(identity("session-1"), edit("edit-1", "One"));
    await expect(
      service.validate(identity("session-2"), edit("edit-2", "Two")),
    ).rejects.toMatchObject({ conflict: { code: "stale_version" } });
    await expect(
      service.propose(identity("session-2"), edit("edit-2", "Two")),
    ).rejects.toMatchObject({
      conflict: {
        code: "stale_version",
        currentVersion: 4,
        affectedNodeIds: [nodeId],
      },
    });
    expect((await service.read(projectId)).proposal?.nodes).toHaveLength(3);
  });

  it("derives stale conflicts from history after the conflicting receipt is pruned", async () => {
    const { service } = await fixture(1);
    const first = await service.propose(
      identity("session-1"),
      addNode("request-1", 0, null),
    );
    const nodeId = first.allocatedNodeIds["request-1" as DraftRef]!;
    await service.propose(identity("session-1"), {
      schemaVersion: 1,
      proposalId: first.proposalId,
      expectedVersion: 1,
      requestId: "edit",
      operations: [
        { kind: "update-node", nodeId, changes: { name: "Changed" } },
      ],
    });
    await service.propose(
      identity("session-1"),
      addNode("disjoint", 2, first.proposalId),
    );

    await expect(
      service.propose(identity("session-2"), {
        schemaVersion: 1,
        proposalId: first.proposalId,
        expectedVersion: 1,
        requestId: "stale-edit",
        operations: [
          { kind: "update-node", nodeId, changes: { purpose: "Stale" } },
        ],
      }),
    ).rejects.toMatchObject({
      conflict: { code: "stale_version", affectedNodeIds: [nodeId] },
    });
  });

  it("commits nothing when validation fails", async () => {
    const { service, accepted } = await fixture();
    const request = addNode("request-1", 0, null);
    request.operations.push(structuredClone(request.operations[0]!));
    await expect(
      service.propose(identity("session-1"), request),
    ).rejects.toBeInstanceOf(AgentMapProposalValidationError);
    expect(await service.read(projectId)).toMatchObject({
      proposal: null,
      workspace: { recordVersion: 1 },
    });
    expect(accepted).not.toHaveBeenCalled();
  });

  it("selects one first writer across independent service instances", async () => {
    const { root } = await fixture();
    const left = new AgentMapProposalService(new AgentMapWorkspaceStore(root), {
      allocator: new Ids(),
    });
    const right = new AgentMapProposalService(
      new AgentMapWorkspaceStore(root),
      {
        allocator: new Ids(),
      },
    );
    const outcomes = await Promise.allSettled([
      left.propose(identity("session-left"), addNode("left", 0, null)),
      right.propose(identity("session-right"), addNode("right", 0, null)),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect((await left.read(projectId)).proposal).toMatchObject({
      version: 1,
      nodes: [expect.any(Object)],
    });
  });

  it("uses one neutral write authority for every ordinary project session", async () => {
    const { service } = await fixture();
    const first = await service.propose(identity("session-one"), addNode("one", 0, null));
    await service.propose(identity("session-two"), addNode("two", 1, first.proposalId));
    await service.propose(identity("session-three"), addNode("three", 2, first.proposalId));
    expect(
      (await service.read(projectId)).proposal?.history.map(
        ({ actor }) => actor,
      ),
    ).toEqual([
      {
        userId: "user-1",
        sessionId: "session-one",
      },
      {
        userId: "user-1",
        sessionId: "session-two",
      },
      {
        userId: "user-1",
        sessionId: "session-three",
      },
    ]);
  });

  it("rejects semantic-edge and delete/update stale conflicts", async () => {
    const { service } = await fixture();
    const initial = await service.propose(identity("planner"), {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "initial",
      operations: [
        {
          kind: "add-node",
          draftRef: "a" as DraftRef,
          node: {
            kind: "agent",
            name: "A",
            purpose: "A",
            ownerAgent: null,
            contractRefs: [],
          },
        },
        {
          kind: "add-node",
          draftRef: "b" as DraftRef,
          node: {
            kind: "agent",
            name: "B",
            purpose: "B",
            ownerAgent: null,
            contractRefs: [],
          },
        },
      ],
    });
    const relationship = (requestId: string): ProposalBatchRequest => ({
      schemaVersion: 1,
      proposalId: initial.proposalId,
      expectedVersion: 1,
      requestId,
      operations: [
        {
          kind: "add-relationship",
          draftRef: requestId as DraftRef,
          relationship: {
            from: { nodeId: initial.allocatedNodeIds["a" as DraftRef]! },
            to: { nodeId: initial.allocatedNodeIds["b" as DraftRef]! },
            kind: "invokes",
            executionMode: "synchronous",
            contractRef: null,
            description: requestId,
          },
        },
      ],
    });
    await service.propose(identity("one"), relationship("edge-one"));
    await expect(
      service.propose(identity("two"), relationship("edge-two")),
    ).rejects.toMatchObject({ conflict: { code: "stale_version" } });

    const current = (await service.read(projectId)).proposal!;
    const nodeId = initial.allocatedNodeIds["a" as DraftRef]!;
    await service.propose(identity("one"), {
      schemaVersion: 1,
      proposalId: initial.proposalId,
      expectedVersion: current.version,
      requestId: "delete",
      operations: [
        {
          kind: "remove-relationship",
          relationshipId: current.relationships[0]!.id,
        },
        { kind: "remove-node", nodeId },
      ],
    });
    await expect(
      service.propose(identity("two"), {
        schemaVersion: 1,
        proposalId: initial.proposalId,
        expectedVersion: current.version,
        requestId: "stale-update",
        operations: [
          { kind: "update-node", nodeId, changes: { name: "Changed" } },
        ],
      }),
    ).rejects.toMatchObject({
      conflict: { code: "stale_version", affectedNodeIds: [nodeId] },
    });
  });

  it("does not advance durable state when allocation fails", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-map-proposal-"),
    );
    roots.push(root);
    const allocator = new Ids();
    allocator.allocateNodeId = vi.fn(() => {
      throw new Error("allocator unavailable");
    });
    const service = new AgentMapProposalService(
      new AgentMapWorkspaceStore(root),
      { allocator },
    );
    await expect(
      service.propose(identity("session-1"), addNode("request-1", 0, null)),
    ).rejects.toThrow("allocator unavailable");
    expect(await service.read(projectId)).toMatchObject({
      proposal: null,
      workspace: { recordVersion: 1 },
    });
  });

  it("rejects an injected allocator collision with existing proposal state", async () => {
    const { root, service } = await fixture();
    const first = await service.propose(
      identity("session-1"),
      addNode("request-1", 0, null),
    );
    const existingNodeId = first.allocatedNodeIds["request-1" as DraftRef]!;
    const allocator = new Ids();
    allocator.allocateNodeId = () => existingNodeId;
    const colliding = new AgentMapProposalService(
      new AgentMapWorkspaceStore(root),
      { allocator },
    );
    await expect(
      colliding.propose(
        identity("session-2"),
        addNode("request-2", 1, first.proposalId),
      ),
    ).rejects.toThrow("duplicate node ID");
    expect((await service.read(projectId)).proposal?.version).toBe(1);
  });

  it("rejects dangling E1 pointers instead of synthesizing incomplete state", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-map-proposal-"),
    );
    roots.push(root);
    const file = path.join(root, "projects", projectId, "workspace.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `${JSON.stringify({
        projectId,
        schemaVersion: 1,
        recordVersion: 2,
        confirmedRevisionId: "revision-1",
        activeProposalId: null,
        projectBuildPlanId: null,
        createdAt: "2026-09-02T12:00:00.000Z",
        updatedAt: "2026-09-02T12:00:00.000Z",
      })}\n`,
    );
    const service = new AgentMapProposalService(
      new AgentMapWorkspaceStore(root),
    );
    await expect(
      service.propose(identity("session-1"), addNode("request-1", 0, null)),
    ).rejects.toMatchObject({ code: "malformed_state" });
    await expect(service.read(projectId)).rejects.toMatchObject({ code: "malformed_state" });
  });
});
