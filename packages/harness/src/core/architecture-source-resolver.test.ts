import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DraftRef, PlanningSessionIdentity } from "../shared/agent-map.js";
import type { AgentMapRevisionId, GraphDigest } from "../shared/build-plan.js";
import { ArchitectureSourceResolver } from "./architecture-source-resolver.js";
import { AgentMapProposalService } from "./agent-map-proposal-service.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { computeArchitectureGraphDigest } from "./build-plan-canonicalization.js";
import { PROJECT_ID } from "./build-plan.test-support.js";

describe("ArchitectureSourceResolver", () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    ),
  );

  it("resolves the exact historical proposal version and verifies its digest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-resolver-"));
    roots.push(root);
    const store = new AgentMapWorkspaceStore(root);
    const service = new AgentMapProposalService(store);
    const identity: PlanningSessionIdentity = {
      projectId: PROJECT_ID,
      userId: "user-1",
      sessionId: "session-1",
      role: "map-planner",
    };
    const created = await service.propose(identity, {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "request-1",
      operations: [
        {
          kind: "add-node",
          draftRef: "draft-1" as DraftRef,
          node: {
            kind: "agent",
            name: "Original",
            purpose: "Build",
            ownerAgent: null,
            contractRefs: [],
          },
        },
      ],
    });
    const versionOneGraph = (await store.readAggregate(PROJECT_ID)).proposal!;
    const graph = {
      nodes: versionOneGraph.nodes,
      relationships: versionOneGraph.relationships,
    };
    const nodeId = created.allocatedNodeIds["draft-1" as DraftRef]!;
    await service.propose(identity, {
      schemaVersion: 1,
      proposalId: created.proposalId,
      expectedVersion: 1,
      requestId: "request-2",
      operations: [
        { kind: "update-node", nodeId, changes: { name: "Changed" } },
      ],
    });
    const source = {
      kind: "proposal" as const,
      proposalId: created.proposalId,
      version: 1,
      graphDigest: computeArchitectureGraphDigest(graph),
    };

    const resolved = await new ArchitectureSourceResolver(store).resolve(
      PROJECT_ID,
      source,
    );

    expect(resolved.graph.nodes[0]?.name).toBe("Original");
    await expect(
      new ArchitectureSourceResolver(store).resolve(PROJECT_ID, {
        ...source,
        graphDigest: `sha256:${"f".repeat(64)}` as GraphDigest,
      }),
    ).rejects.toMatchObject({ code: "source_digest_mismatch" });
  });

  it("resolves revisions exactly and rejects cross-project snapshots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-resolver-"));
    roots.push(root);
    const revisionId =
      "revision_00000000-0000-7000-8000-000000000006" as AgentMapRevisionId;
    const graph = { nodes: [], relationships: [] };
    const resolver = new ArchitectureSourceResolver(
      new AgentMapWorkspaceStore(root),
      async () => ({
        projectId: "project_00000000-0000-4000-8000-000000000009",
        revisionId,
        revisionNumber: 2,
        graph,
      }),
    );

    await expect(
      resolver.resolve(PROJECT_ID, {
        kind: "revision",
        revisionId,
        revisionNumber: 2,
        graphDigest: computeArchitectureGraphDigest(graph),
      }),
    ).rejects.toMatchObject({ code: "cross_project" });
  });

  it("rejects a revision reader that returns a different revision identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-resolver-"));
    roots.push(root);
    const requestedId =
      "revision_00000000-0000-7000-8000-000000000006" as AgentMapRevisionId;
    const returnedId =
      "revision_00000000-0000-7000-8000-000000000007" as AgentMapRevisionId;
    const graph = { nodes: [], relationships: [] };
    const resolver = new ArchitectureSourceResolver(
      new AgentMapWorkspaceStore(root),
      async () => ({
        projectId: PROJECT_ID,
        revisionId: returnedId,
        revisionNumber: 2,
        graph,
      }),
    );

    await expect(
      resolver.resolve(PROJECT_ID, {
        kind: "revision",
        revisionId: requestedId,
        revisionNumber: 2,
        graphDigest: computeArchitectureGraphDigest(graph),
      }),
    ).rejects.toMatchObject({ code: "source_not_found" });
  });

  it("verifies the proposal base revision identity before materializing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-resolver-"));
    roots.push(root);
    const store = new AgentMapWorkspaceStore(root);
    const baseRevisionId =
      "revision_00000000-0000-7000-8000-000000000006" as AgentMapRevisionId;
    const wrongRevisionId =
      "revision_00000000-0000-7000-8000-000000000007" as AgentMapRevisionId;
    await store.readOrCreate(PROJECT_ID);
    await store.transact(PROJECT_ID, async (aggregate) => ({
      value: undefined,
      next: {
        ...aggregate,
        workspace: {
          ...aggregate.workspace,
          confirmedRevisionId: baseRevisionId,
          recordVersion: aggregate.workspace.recordVersion + 1,
          updatedAt: "2026-09-03T09:00:00.000Z",
        },
      },
    }));
    const service = new AgentMapProposalService(store, {
      readBaseRevision: async () => ({ nodes: [], relationships: [] }),
    });
    const identity: PlanningSessionIdentity = {
      projectId: PROJECT_ID,
      userId: "user-1",
      sessionId: "session-1",
      role: "map-planner",
    };
    const created = await service.propose(identity, {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "request-base",
      operations: [
        {
          kind: "add-node",
          draftRef: "draft-base" as DraftRef,
          node: {
            kind: "agent",
            name: "Builder",
            purpose: "Build",
            ownerAgent: null,
            contractRefs: [],
          },
        },
      ],
    });
    const proposal = (await store.readAggregate(PROJECT_ID)).proposal!;
    const source = {
      kind: "proposal" as const,
      proposalId: created.proposalId,
      version: 1,
      graphDigest: computeArchitectureGraphDigest({
        nodes: proposal.nodes,
        relationships: proposal.relationships,
      }),
    };
    const resolver = new ArchitectureSourceResolver(store, async () => ({
      projectId: PROJECT_ID,
      revisionId: wrongRevisionId,
      revisionNumber: 1,
      graph: { nodes: [], relationships: [] },
    }));

    await expect(resolver.resolve(PROJECT_ID, source)).rejects.toMatchObject({
      code: "source_not_found",
    });
  });
});
