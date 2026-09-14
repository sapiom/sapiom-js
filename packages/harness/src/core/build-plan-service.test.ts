import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DraftRef,
  PlanNodeId,
  ProjectAgentSession,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  AgentBriefId,
  AgentBriefScopeKey,
  AgentBriefSemanticDigest,
  AgentBriefVersion,
  AgentBriefVersionId,
  ProjectBuildPlanVersionId,
  ProjectBuildPlanVersionRef,
} from "../shared/build-plan.js";
import { parseProjectBuildPlanVersion } from "../shared/build-plan-codec.js";
import { AgentMapProposalService } from "./agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { BuildPlanService } from "./build-plan-service.js";
import { appendRestoredBuildPlanVersion, BuildPlanStore } from "./build-plan-store.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
} from "./build-plan-canonicalization.js";

const projectId = "project_018f0000-0000-4000-8000-000000000001" as StudioProjectId;
const identity = (sessionId = "session-plan"): ProjectAgentSession => ({ projectId, userId: "user-1", sessionId });

describe("BuildPlanService", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

  async function fixture(
    receiptRetentionLimit?: number,
    versionHistoryLimit?: number,
    briefReceiptRetentionLimit?: number,
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-plan-service-"));
    roots.push(root);
    const aggregateStore = new AgentMapWorkspaceStore(root, {
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      ...(briefReceiptRetentionLimit === undefined ? {} : { briefReceiptRetentionLimit }),
    });
    const mapService = new AgentMapProposalService(aggregateStore, {
      now: () => new Date("2026-01-02T03:04:06.000Z"),
    });
    const added = await mapService.propose(identity("map-session"), {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "map-create",
      operations: [
        { kind: "add-node", draftRef: "research" as DraftRef,
          node: { kind: "agent", name: "Research", purpose: "Research", ownerAgent: null, contractRefs: [] } },
        { kind: "add-node", draftRef: "publisher" as DraftRef,
          node: { kind: "agent", name: "Publisher", purpose: "Publish", ownerAgent: null, contractRefs: [] } },
        { kind: "add-node", draftRef: "report" as DraftRef,
          node: { kind: "artifact", name: "ResearchReport", purpose: "Daily report", ownerAgent: null, contractRefs: ["ResearchReport"] } },
        { kind: "add-relationship", draftRef: "writes" as DraftRef,
          relationship: { from: { draftRef: "research" as DraftRef }, to: { draftRef: "report" as DraftRef },
            kind: "writes", executionMode: "asynchronous", contractRef: "ResearchReport", description: "Persist report" } },
        { kind: "add-relationship", draftRef: "feeds" as DraftRef,
          relationship: { from: { draftRef: "report" as DraftRef }, to: { draftRef: "publisher" as DraftRef },
            kind: "feeds", executionMode: "asynchronous", contractRef: "ResearchReport", description: "Feed publisher" } },
      ],
    });
    const aggregate = await aggregateStore.readAggregate(projectId);
    const refs = {
      research: added.allocatedNodeIds["research" as DraftRef] as PlanNodeId,
      publisher: added.allocatedNodeIds["publisher" as DraftRef] as PlanNodeId,
      report: added.allocatedNodeIds["report" as DraftRef] as PlanNodeId,
      writes: added.allocatedRelationshipIds["writes" as DraftRef]!,
      feeds: added.allocatedRelationshipIds["feeds" as DraftRef]!,
      map: aggregate.current.map!,
      proposalId: added.proposalId,
    };
    const outcomes = vi.fn();
    const service = new BuildPlanService(new BuildPlanStore(aggregateStore), {
      now: () => new Date("2026-01-02T03:05:05.000Z"),
      onOutcome: outcomes,
      ...(receiptRetentionLimit === undefined ? {} : { receiptRetentionLimit }),
      ...(versionHistoryLimit === undefined ? {} : { versionHistoryLimit }),
    });
    return { root, aggregateStore, mapService, service, refs, outcomes };
  }

  function content(refs: Awaited<ReturnType<typeof fixture>>["refs"]) {
    return {
      outcome: "Deliver research and publication.",
      nonGoals: ["Trading"],
      milestones: [{ id: { clientRef: "milestone-research" }, ordinal: 1, title: "Research",
        outcome: "Report ready", dependsOn: [] }],
      sequenceGates: [{ id: { clientRef: "gate-report" }, ordinal: 1, description: "Report before publish",
        milestoneIds: [{ clientRef: "milestone-research" }] }],
      sharedConstraints: ["Use current market data"],
      repositoryIntents: [{ id: { clientRef: "repository-research" }, plannedAgentId: refs.research,
        repository: "research", packages: ["packages/research"], ownershipBoundaries: ["Market data"] }],
      integrationCriteria: ["Publisher consumes persisted report"],
      acceptanceCriteria: ["Ten stocks are ranked"],
      decisions: [],
      assignments: [
        { id: { clientRef: "assignment-research" }, plannedAgentId: refs.research, briefId: null,
          mission: "Produce report", scope: ["Research"], nonGoals: ["Publishing"], dependencies: [
            { id: { clientRef: "dependency-output" }, kind: "output" as const, nodeId: refs.report,
              relationshipIds: [refs.writes], contractRef: "ResearchReport" },
          ] },
        { id: { clientRef: "assignment-publisher" }, plannedAgentId: refs.publisher,
          briefId: { clientRef: "brief-publisher" }, mission: "Publish report", scope: ["Publishing"], nonGoals: ["Research"],
          dependencies: [{ id: { clientRef: "dependency-input" }, kind: "input" as const, nodeId: refs.report,
            relationshipIds: [refs.feeds], contractRef: "ResearchReport" }] },
      ],
      unresolvedDecisions: [{ id: { clientRef: "decision-format" }, question: "Video format?", resolution: "", status: "open" as const }],
      risks: [{ id: { clientRef: "risk-market" }, description: "Market feed delayed", mitigation: "Retry" }],
    };
  }

  const toolPlanRef = (ref: ProjectBuildPlanVersionRef) => ({
    planId: ref.planId,
    versionId: ref.versionId,
    semanticDigest: ref.semanticDigest,
  });
  const toolMapRef = (ref: Awaited<ReturnType<typeof fixture>>["refs"]["map"]) => ({
    versionId: ref.versionId,
    contentDigest: ref.contentDigest,
  });

  it("validates without side effects and apply uses the same deterministic mappings", async () => {
    const { aggregateStore, service, refs } = await fixture();
    const request = { schemaVersion: 1, requestId: "plan-create", expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] };
    const before = await aggregateStore.readAggregate(projectId);
    const preview = await service.validate(identity(), request);
    const recreated = await service.validate(identity(), { ...request, requestId: "plan-create-again" });
    const afterValidate = await aggregateStore.readAggregate(projectId);
    const applied = await service.apply(identity(), request);

    expect(afterValidate).toEqual(before);
    expect(preview.mappings).toEqual(applied.mappings);
    expect(recreated.mappings.map(({ id }) => id)).not.toEqual(preview.mappings.map(({ id }) => id));
    expect(preview.plan).toEqual(applied.plan);
    expect(applied.created).toBe(true);
    expect(applied.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-brief", severity: "warning" }),
      expect.objectContaining({ code: "unresolved-decision", severity: "warning" }),
    ]));
    const aggregate = await aggregateStore.readAggregate(projectId);
    expect(aggregate.buildPlanVersions).toHaveLength(1);
    expect(aggregate.current.buildPlan).toEqual(applied.plan);
    expect(aggregate.current.briefsByScope).toEqual({});
    expect(aggregate.briefVersionsById).toEqual({});
  });

  it("classifies an oversized deterministic-ID mapping request as correctable", async () => {
    const { aggregateStore, service, refs } = await fixture();
    const before = await aggregateStore.readAggregate(projectId);
    const oversized = {
      ...content(refs),
      milestones: Array.from({ length: 128 }, (_, index) => ({
        id: { clientRef: `milestone-${index}` }, ordinal: index + 1,
        title: `Milestone ${index + 1}`, outcome: "Complete", dependsOn: [],
      })),
      sequenceGates: [],
      repositoryIntents: [],
      assignments: [],
      unresolvedDecisions: [],
      risks: [{ id: { clientRef: "risk-over-limit" }, description: "Capacity", mitigation: "Split request" }],
    };

    await expect(service.validate(identity(), {
      schemaVersion: 1, requestId: "oversized-mappings",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: oversized }],
    })).rejects.toMatchObject({
      code: "request_too_large",
      details: { affectedPaths: ["operations.0.content"] },
    });
    expect(await aggregateStore.readAggregate(projectId)).toEqual(before);
  });

  it("returns exact current and historical versions and rejects ambiguous reads", async () => {
    const { service, refs } = await fixture();
    await expect(service.read(identity(), {})).rejects.toMatchObject({ code: "malformed_input" });
    await expect(service.read(identity(), { kind: "current" })).resolves.toMatchObject({ plan: null, history: [] });
    const first = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    const exact = await service.read(identity(), { kind: "exact", ...toolPlanRef(first.plan) });
    expect(exact.plan).toMatchObject({ version: 1, versionId: first.plan.versionId });
    await expect(service.read(identity(), { kind: "exact", ...toolPlanRef(first.plan), semanticDigest: `sha256:${"0".repeat(64)}` }))
      .rejects.toMatchObject({ code: "source_mismatch" });
  });

  it("replays the original result, rejects changed request bodies, and records semantic no-ops without new versions", async () => {
    const { aggregateStore, service, refs, outcomes } = await fixture();
    const create = { schemaVersion: 1, requestId: "plan-create", expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] };
    const first = await service.apply(identity(), create);
    const reordered = structuredClone(create);
    reordered.operations[0]!.content.assignments.reverse();
    reordered.operations[0]!.content.nonGoals.reverse();
    const replay = await service.apply(identity(), reordered);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(outcomes).toHaveBeenCalledWith(expect.objectContaining({
      operation: "apply",
      outcome: "replayed",
      version: 1,
    }));
    await expect(service.apply(identity(), { ...create, operations: [{ op: "replace-content",
      content: { ...content(refs), outcome: "Changed" } }] })).rejects.toMatchObject({ code: "request_id_reused" });

    const persisted = (await service.read(identity(), { kind: "current" })).plan!.content;
    const noOp = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-no-op",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(first.plan),
      operations: [{ op: "replace-content", content: persisted }] });
    expect(noOp.created).toBe(false);
    expect((await aggregateStore.readAggregate(projectId)).buildPlanVersions).toHaveLength(1);
  });

  it.each(["validate", "apply"] as const)("%s rejects invalid plans after more than 64 warnings", async (operation) => {
    const { aggregateStore, service, refs } = await fixture();
    const base = content(refs);
    const invalid = { ...base,
      milestones: [...base.milestones, { ...base.milestones[0]!, id: { clientRef: "duplicate-ordinal" } }],
      decisions: Array.from({ length: 65 }, (_, index) => ({ id: { clientRef: `open-${index}` },
        question: `Question ${index}`, resolution: "", status: "open" as const })),
    };
    const before = await aggregateStore.readAggregate(projectId);
    await expect(service[operation](identity(), { schemaVersion: 1, requestId: "warning-overflow",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: invalid }] })).rejects.toMatchObject({
        code: "validation_failed", details: { diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "duplicate-ordinal", severity: "error" }),
        ]) },
      });
    expect(await aggregateStore.readAggregate(projectId)).toEqual(before);
  });

  it("timestamps a semantic no-op at receipt creation instead of the old plan version", async () => {
    const { aggregateStore, service, refs } = await fixture();
    const first = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    const current = (await service.read(identity(), { kind: "current" })).plan!.content;
    const now = "2026-01-02T03:06:05.000Z";
    const laterService = new BuildPlanService(new BuildPlanStore(aggregateStore), { now: () => new Date(now) });
    await laterService.apply(identity(), { schemaVersion: 1, requestId: "plan-later-no-op",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(first.plan),
      operations: [{ op: "replace-content", content: current }] });
    const aggregate = await aggregateStore.readAggregate(projectId);
    expect(aggregate.updatedAt).toBe(now);
    expect(aggregate.requestReceipts.at(-1)?.createdAt).toBe(now);
    expect(aggregate.buildPlanVersions).toHaveLength(1);
    expect(aggregate.buildPlanVersions[0]?.createdAt).toBe("2026-01-02T03:05:05.000Z");
  });

  it("merges same-source stale disjoint changes and reports stable overlapping conflicts", async () => {
    const { service, refs } = await fixture();
    const created = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    const base = (await service.read(identity(), { kind: "current" })).plan!.content;
    const [research, publisher] = base.assignments;
    const first = await service.apply(identity("session-a"), { schemaVersion: 1, requestId: "edit-a",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(created.plan),
      operations: [{ op: "replace-content", content: { ...base,
        assignments: [{ ...research!, mission: "Produce ranked report" }, publisher!] } }] });
    const second = await service.apply(identity("session-b"), { schemaVersion: 1, requestId: "edit-b",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(created.plan),
      operations: [{ op: "replace-content", content: { ...base,
        assignments: [research!, { ...publisher!, mission: "Publish daily video" }] } }] });
    const merged = (await service.read(identity(), { kind: "current" })).plan!;
    expect([first.created, second.created]).toEqual([true, true]);
    expect(merged.version).toBe(3);
    expect(merged.content.assignments.map(({ mission }) => mission).sort()).toEqual([
      "Produce ranked report", "Publish daily video",
    ]);
    await expect(service.apply(identity("session-c"), { schemaVersion: 1, requestId: "edit-conflict",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(created.plan),
      operations: [{ op: "replace-content", content: { ...base,
        assignments: [{ ...research!, mission: "Conflicting mission" }, publisher!] } }] }))
      .rejects.toMatchObject({ code: "stale_plan_conflict",
        details: { affectedIds: [research!.id], affectedPaths: [`assignments:${research!.id}`] } });
  });

  it("requires explicit rebase across map versions and preserves the semantic digest for source-only rebases", async () => {
    const { aggregateStore, mapService, service, refs } = await fixture();
    const created = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    await mapService.propose(identity("map-session"), { schemaVersion: 1, proposalId: refs.proposalId,
      expectedVersion: 1, requestId: "map-rename",
      operations: [{ kind: "update-node", nodeId: refs.research, changes: { name: "Market Research" } }] });
    const currentMap = (await mapService.read(projectId)).workspace.confirmedRevisionId;
    const aggregate = await aggregateStore.readAggregate(projectId);
    const toMap = aggregate.current.map!;
    expect(currentMap).toBe(toMap.versionId);
    await expect(service.apply(identity(), { schemaVersion: 1, requestId: "wrong-source",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(created.plan),
      operations: [{ op: "replace-content", content: (await service.read(identity(), { kind: "current" })).plan!.content }] }))
      .rejects.toMatchObject({ code: "source_mismatch" });
    const rebased = await service.rebase(identity(), { schemaVersion: 1, requestId: "source-rebase",
      expectedPlan: toolPlanRef(created.plan), fromMap: toolMapRef(refs.map), toMap: toolMapRef(toMap), resolutions: [] });
    expect(rebased.created).toBe(true);
    expect(rebased.plan.semanticDigest).toBe(created.plan.semanticDigest);
    expect((await service.read(identity(), { kind: "current" })).plan).toMatchObject({
      version: 2,
      changeKind: "rebased",
      map: toMap,
    });
  });

  it("never silently drops map-invalidated assignments during rebase", async () => {
    const { aggregateStore, mapService, service, refs } = await fixture();
    const initialContent = content(refs);
    initialContent.repositoryIntents = [
      { id: { clientRef: "repository-publisher-a" }, plannedAgentId: refs.publisher,
        repository: "publisher-a", packages: [], ownershipBoundaries: ["Publishing A"] },
      ...initialContent.repositoryIntents,
      { id: { clientRef: "repository-publisher-b" }, plannedAgentId: refs.publisher,
        repository: "publisher-b", packages: [], ownershipBoundaries: ["Publishing B"] },
    ];
    const created = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: initialContent }] });
    const plan = (await service.read(identity(), { kind: "current" })).plan!;
    const publisherAssignment = plan.content.assignments.find(({ plannedAgentId }) => plannedAgentId === refs.publisher)!;
    const publisherRepositories = plan.content.repositoryIntents
      .filter(({ plannedAgentId }) => plannedAgentId === refs.publisher);
    expect(publisherRepositories).toHaveLength(2);
    await mapService.propose(identity("map-session"), { schemaVersion: 1, proposalId: refs.proposalId,
      expectedVersion: 1, requestId: "map-remove-publisher",
      operations: [
        { kind: "remove-relationship", relationshipId: refs.feeds },
        { kind: "remove-node", nodeId: refs.publisher },
      ] });
    const toMap = (await aggregateStore.readAggregate(projectId)).current.map!;
    await expect(service.rebase(identity(), { schemaVersion: 1, requestId: "missing-resolution",
      expectedPlan: toolPlanRef(created.plan), fromMap: toolMapRef(refs.map), toMap: toolMapRef(toMap), resolutions: [] }))
      .rejects.toMatchObject({ code: "rebase_resolution_required",
        details: { affectedIds: expect.arrayContaining([refs.publisher]) } });
    const rebased = await service.rebase(identity(), { schemaVersion: 1, requestId: "explicit-removal",
      expectedPlan: toolPlanRef(created.plan), fromMap: toolMapRef(refs.map), toMap: toolMapRef(toMap),
      resolutions: [
        { kind: "remove-assignment", assignmentId: publisherAssignment.id },
        ...publisherRepositories.map(({ id }) => ({
          kind: "remove-repository-intent" as const,
          repositoryIntentId: id,
        })),
      ] });
    expect(rebased.created).toBe(true);
    const rebasedContent = (await service.read(identity(), { kind: "current" })).plan!.content;
    expect(rebasedContent.assignments)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: publisherAssignment.id })]));
    expect(rebasedContent.repositoryIntents).toHaveLength(1);
    expect(rebasedContent.repositoryIntents[0]).toMatchObject({ plannedAgentId: refs.research });
  });

  it("rejects dependency claims without relationship-aware contract evidence", async () => {
    const { service, refs } = await fixture();
    const invalid = content(refs);
    invalid.assignments[0]!.dependencies[0]!.relationshipIds = [refs.feeds];
    await expect(service.validate(identity(), { schemaVersion: 1, requestId: "invalid-dependency",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: invalid }] })).rejects.toMatchObject({
        code: "validation_failed",
        details: { diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "invalid-dependency", severity: "error" }),
        ]) },
      });
  });

  it("compacts receipts into permanent tombstones and rejects expired request IDs", async () => {
    const { service, refs } = await fixture(1);
    const created = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    const current = (await service.read(identity(), { kind: "current" })).plan!.content;
    await service.apply(identity(), { schemaVersion: 1, requestId: "plan-no-op",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(created.plan),
      operations: [{ op: "replace-content", content: current }] });
    await expect(service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] })).rejects.toMatchObject({ code: "request_id_expired" });
  });

  it("fails history quota before mutation with a bounded terminal error", async () => {
    const { aggregateStore, service, refs } = await fixture(undefined, 1);
    const created = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    const before = await aggregateStore.readAggregate(projectId);
    const persisted = (await service.read(identity(), { kind: "current" })).plan!.content;
    await expect(service.apply(identity(), { schemaVersion: 1, requestId: "plan-over-quota",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(created.plan),
      operations: [{ op: "replace-content", content: { ...persisted, outcome: "Changed outcome" } }] }))
      .rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await aggregateStore.readAggregate(projectId)).toEqual(before);
  });

  it("deduplicates concurrent same-request writers across independent service instances", async () => {
    const { root, aggregateStore, refs } = await fixture();
    const left = new BuildPlanService(new BuildPlanStore(aggregateStore), {
      now: () => new Date("2026-01-02T03:05:05.000Z"),
    });
    const right = new BuildPlanService(new BuildPlanStore(new AgentMapWorkspaceStore(root)), {
      now: () => new Date("2026-01-02T03:05:05.000Z"),
    });
    const request = { schemaVersion: 1, requestId: "concurrent-create", expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] };
    const [first, second] = await Promise.all([left.apply(identity(), request), right.apply(identity(), request)]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect((await aggregateStore.readAggregate(projectId)).buildPlanVersions).toHaveLength(1);
  });

  it("leaves no plan version, pointer, or receipt after atomic replacement failure and retries cleanly", async () => {
    const { root, aggregateStore, refs } = await fixture();
    let failRename = true;
    const failing = new BuildPlanService(new BuildPlanStore(new AgentMapWorkspaceStore(root, {
      beforePersistStep: (step) => {
        if (failRename && step === "rename") throw new Error("injected rename failure");
      },
    })), { now: () => new Date("2026-01-02T03:05:05.000Z") });
    const request = { schemaVersion: 1, requestId: "atomic-create", expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] };
    await expect(failing.apply(identity(), request)).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await aggregateStore.readAggregate(projectId)).toMatchObject({
      current: { buildPlan: null },
      buildPlanVersions: [],
    });
    expect((await aggregateStore.readAggregate(projectId)).requestReceipts)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ requestId: "atomic-create" })]));
    failRename = false;
    await expect(failing.apply(identity(), request)).resolves.toMatchObject({ created: true, replayed: false });
  });

  it("provides append-only plan restoration with exact historical provenance", async () => {
    const { aggregateStore, service, refs } = await fixture();
    const first = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    const initial = (await service.read(identity(), { kind: "current" })).plan!;
    await service.apply(identity(), { schemaVersion: 1, requestId: "plan-edit",
      expectedMap: toolMapRef(refs.map), expectedPlan: toolPlanRef(first.plan),
      operations: [{ op: "replace-content", content: { ...initial.content, outcome: "A changed outcome" } }] });
    const aggregate = await aggregateStore.readAggregate(projectId);
    const current = aggregate.current.buildPlan!;
    const restored = appendRestoredBuildPlanVersion({
      projectId,
      versions: aggregate.buildPlanVersions,
      expectedCurrent: current,
      historical: first.plan,
      versionId: "planv_018f0000-0000-7000-8000-000000000099" as ProjectBuildPlanVersionId,
      actor: { userId: "user-restore", sessionId: "session-restore" },
      createdAt: "2026-01-02T03:06:05.000Z",
      origin: { kind: "request", requestDigest: `sha256:${"9".repeat(64)}`, operationIds: [], touchKeys: ["restore"] },
    });
    expect(restored).toMatchObject({ version: 3, parentVersionId: current.versionId,
      restoredFromVersionId: first.plan.versionId, changeKind: "restored",
      semanticDigest: first.plan.semanticDigest, map: initial.map });
    expect(restored.recordDigest).not.toBe(initial.recordDigest);
    expect(parseProjectBuildPlanVersion(restored, projectId)).toEqual(restored);
  });

  it("reserves append-only active, retired, reactivated, and nested brief histories by neutral scope", async () => {
    const { root, aggregateStore, service, refs } = await fixture(undefined, undefined, 2);
    const applied = await service.apply(identity(), { schemaVersion: 1, requestId: "plan-create",
      expectedMap: toolMapRef(refs.map), expectedPlan: null,
      operations: [{ op: "replace-content", content: content(refs) }] });
    const plan = (await service.read(identity(), { kind: "current" })).plan!;
    const assignment = plan.content.assignments[0]!;
    const briefStore = new BuildPlanStore(aggregateStore);
    const scopeKey = "scope_research" as AgentBriefScopeKey;
    const briefId = "brief_018f0000-0000-7000-8000-000000000050" as AgentBriefId;
    const brief = (version: number, parentVersionId: AgentBriefVersionId | null): AgentBriefVersion => {
      const base = {
        schemaVersion: 1 as const,
        projectId,
        briefId,
        scopeKey,
        focusScope: { family: "canonical-workstream" as const, plannedAgentId: assignment.plannedAgentId },
        versionId: `briefv_018f0000-0000-7000-8000-00000000005${version}` as AgentBriefVersionId,
        version,
        parentVersionId,
        changeKind: (version === 1 ? "created" : "edited") as "created" | "edited",
        restoredFromVersionId: null,
        assignmentId: assignment.id,
        plannedAgentId: assignment.plannedAgentId,
        map: refs.map,
        plan: applied.plan,
        content: { mission: assignment.mission, scope: assignment.scope, nonGoals: assignment.nonGoals,
          ownedNodeIds: [assignment.plannedAgentId], relevantNodeIds: [], inputs: [], outputs: [], dependencies: [],
          sharedResourceNodeIds: [], sequenceGateIds: [], deliverables: [], acceptanceCriteria: [], constraints: [],
          milestoneIds: [], unresolvedDecisionIds: [] },
        compilerVersion: "reserved-test",
        compilerInputFingerprint: `sha256:${String(version).repeat(64)}`,
        semanticDigest: "" as AgentBriefSemanticDigest,
        authoredBy: { userId: "compiler-user", sessionId: "compiler-session" },
        createdAt: `2026-01-02T03:0${5 + version}:05.000Z`,
        origin: { kind: "request" as const, requestDigest: `sha256:${String(version).repeat(64)}`,
          operationIds: [], touchKeys: [scopeKey] },
      };
      const withSemantic = { ...base, semanticDigest: computeAgentBriefSemanticDigest(base) };
      return { ...withSemantic, recordDigest: computeAgentBriefRecordDigest(withSemantic) };
    };
    const receipt = (value: AgentBriefVersion, status: "active" | "retired") => ({
      map: refs.map,
      plan: applied.plan,
      briefs: [{ scopeKey: value.scopeKey, briefId: value.briefId, versionId: value.versionId,
        version: value.version, disposition: value.version === 1 ? "created" as const : "new-version" as const,
        status }],
      impact: { affectedWorkstreamCount: 0, entries: [], staleBriefIds: [], preservedBriefIds: [],
        changedNodeIds: [], changedRelationshipIds: [], changedContractRefs: [], digest: `sha256:${"d".repeat(64)}` },
      diagnostics: [],
    });
    const first = brief(1, null);
    await briefStore.appendBriefVersions(projectId, { actor: first.authoredBy, requestId: "brief-retire",
      requestDigest: `sha256:${"a".repeat(64)}`, expectedMap: refs.map, expectedPlan: applied.plan,
      entries: [{ version: first, status: "retired" }], receipt: receipt(first, "retired"), createdAt: first.createdAt });
    const second = brief(2, first.versionId);
    const reactivated = await briefStore.appendBriefVersions(projectId, { actor: second.authoredBy,
      requestId: "brief-reactivate", requestDigest: `sha256:${"b".repeat(64)}`, expectedMap: refs.map,
      expectedPlan: applied.plan, entries: [{ version: second, status: "active" }], receipt: receipt(second, "active"),
      createdAt: second.createdAt });
    await expect(briefStore.appendBriefVersions(projectId, { actor: second.authoredBy,
      requestId: "brief-reactivate", requestDigest: `sha256:${"b".repeat(64)}`, expectedMap: refs.map,
      expectedPlan: applied.plan, entries: [{ version: second, status: "active" }], receipt: receipt(second, "active"),
      createdAt: second.createdAt }))
      .resolves.toEqual({ ...reactivated, replayed: true });
    const nestedBriefId = "brief_018f0000-0000-7000-8000-000000000060" as AgentBriefId;
    const nestedScopeKey = "scope_research_analysis" as AgentBriefScopeKey;
    const nestedBase = { ...second, briefId: nestedBriefId, scopeKey: nestedScopeKey,
      focusScope: { family: "ad-hoc-delegation" as const, delegationKey: "analysis", parentScopeKey: scopeKey },
      versionId: "briefv_018f0000-0000-7000-8000-000000000061" as AgentBriefVersionId,
      version: 1, parentVersionId: null, changeKind: "created" as const,
      createdAt: "2026-01-02T03:08:05.000Z" };
    const nestedWithSemantic = { ...nestedBase, semanticDigest: computeAgentBriefSemanticDigest(nestedBase) };
    const nested = { ...nestedWithSemantic, recordDigest: computeAgentBriefRecordDigest(nestedWithSemantic) };
    await briefStore.appendBriefVersions(projectId, { actor: nested.authoredBy, requestId: "brief-nested",
      requestDigest: `sha256:${"c".repeat(64)}`, expectedMap: refs.map, expectedPlan: applied.plan,
      entries: [{ version: nested, status: "active" }], receipt: receipt(nested, "active"), createdAt: nested.createdAt });
    const aggregate = await aggregateStore.readAggregate(projectId);
    expect(aggregate.briefVersionsById[briefId]).toHaveLength(2);
    expect(aggregate.current.briefsByScope[scopeKey]).toMatchObject({
      status: "active",
      focusScope: { family: "canonical-workstream", plannedAgentId: assignment.plannedAgentId },
      version: { versionId: second.versionId },
    });
    expect(aggregate.current.briefsByScope[nestedScopeKey]).toMatchObject({
      briefId: nestedBriefId,
      status: "active",
      focusScope: { family: "ad-hoc-delegation", delegationKey: "analysis", parentScopeKey: scopeKey },
    });
    expect(aggregate.requestReceipts.filter(({ operation }) => operation === "brief_append")
      .map(({ requestId }) => requestId)).toEqual(["brief-reactivate", "brief-nested"]);
    expect(aggregate.requestTombstones).toContainEqual(expect.objectContaining({
      requestId: "brief-retire",
      operation: "brief_append",
    }));
    // Startup must preserve even populated format-2 plans/briefs whose nested
    // records all use schemaVersion 1, including retired history and receipts.
    const file = path.join(root, "projects", projectId, "workspace.json");
    const beforeReset = await fs.readFile(file);
    await aggregateStore.resetLegacyMaps();
    await new AgentMapWorkspaceStore(root).resetLegacyMaps();
    expect(await fs.readFile(file)).toEqual(beforeReset);
  });
});
