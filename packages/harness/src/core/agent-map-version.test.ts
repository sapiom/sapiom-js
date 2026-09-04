import { describe, expect, it } from "vitest";

import type {
  AgentMapVersionId,
  PlanNode,
  PlanNodeId,
  ProposalOperationId,
  StudioProjectId,
} from "../shared/agent-map.js";
import {
  agentMapVersionRef,
  appendRestoredAgentMapVersion,
  createAgentMapVersion,
  validateAgentMapVersionHistory,
} from "./agent-map-version.js";
import { AgentMapVersionResolver } from "./agent-map-version-resolver.js";

const projectId = "project_018f0000-0000-4000-8000-000000000001" as StudioProjectId;
const actor = { userId: "user", sessionId: "session" };
const at = "2026-01-02T03:04:05.000Z";
const origin = (digit: string) => ({
  kind: "request" as const,
  requestDigest: `sha256:${digit.repeat(64)}`,
  operationIds: [`operation_018f0000-0000-7000-8000-00000000000${digit}` as ProposalOperationId],
  touchKeys: [`node:node-${digit}`],
});
const node = (name: string): PlanNode => ({
  id: "node_018f0000-0000-7000-8000-000000000010" as PlanNodeId,
  kind: "agent",
  name,
  purpose: "Research stocks",
  ownerAgentId: null,
  contractRefs: [],
});
const versionId = (suffix: string) =>
  `mapv_018f0000-0000-7000-8000-0000000000${suffix}` as AgentMapVersionId;

describe("immutable Agent Map versions", () => {
  it("resolves current and exact history while rejecting cross-project and digest-mismatched refs", () => {
    const first = createAgentMapVersion({
      projectId,
      versionId: versionId("20"),
      version: 1,
      parentVersionId: null,
      graph: { nodes: [node("Research")], relationships: [] },
      changeKind: "created",
      restoredFromVersionId: null,
      authoredBy: actor,
      createdAt: at,
      origin: origin("1"),
    });
    const second = createAgentMapVersion({
      projectId,
      versionId: versionId("21"),
      version: 2,
      parentVersionId: first.versionId,
      graph: { nodes: [node("Market Research")], relationships: [] },
      changeKind: "edited",
      restoredFromVersionId: null,
      authoredBy: actor,
      createdAt: "2026-01-02T03:05:05.000Z",
      origin: origin("2"),
    });
    const resolver = new AgentMapVersionResolver(projectId, [first, second], agentMapVersionRef(second));
    expect(resolver.readCurrent()).toEqual(second);
    expect(resolver.readExact(agentMapVersionRef(first))).toEqual(first);
    expect(() => resolver.readExact({ ...agentMapVersionRef(first), contentDigest: second.contentDigest }))
      .toThrowError(expect.objectContaining({ code: "source_mismatch" }));
    expect(() => resolver.readExact({
      ...agentMapVersionRef(first),
      projectId: "project_018f0000-0000-4000-8000-000000000002" as StudioProjectId,
    })).toThrowError(expect.objectContaining({ code: "cross_project_reference" }));
  });

  it("restores by appending a new child with copied semantics and explicit provenance", () => {
    const first = createAgentMapVersion({
      projectId,
      versionId: versionId("20"),
      version: 1,
      parentVersionId: null,
      graph: { nodes: [node("Research")], relationships: [] },
      changeKind: "created",
      restoredFromVersionId: null,
      authoredBy: actor,
      createdAt: at,
      origin: origin("1"),
    });
    const second = createAgentMapVersion({
      projectId,
      versionId: versionId("21"),
      version: 2,
      parentVersionId: first.versionId,
      graph: { nodes: [node("Market Research")], relationships: [] },
      changeKind: "edited",
      restoredFromVersionId: null,
      authoredBy: actor,
      createdAt: "2026-01-02T03:05:05.000Z",
      origin: origin("2"),
    });
    const restored = appendRestoredAgentMapVersion({
      projectId,
      versions: [first, second],
      expectedCurrent: agentMapVersionRef(second),
      historical: agentMapVersionRef(first),
      versionId: versionId("22"),
      actor: { userId: "restorer", sessionId: "restore-session" },
      createdAt: "2026-01-02T03:06:05.000Z",
      origin: origin("3"),
    });
    expect(restored).toMatchObject({
      version: 3,
      parentVersionId: second.versionId,
      changeKind: "restored",
      restoredFromVersionId: first.versionId,
      graph: first.graph,
      contentDigest: first.contentDigest,
      authoredBy: { userId: "restorer", sessionId: "restore-session" },
    });
    expect(restored.recordDigest).not.toBe(first.recordDigest);
    expect(() => validateAgentMapVersionHistory([first, second, restored], projectId)).not.toThrow();
  });

  it("rejects ancestry corruption and invalid graph topology", () => {
    expect(() => createAgentMapVersion({
      projectId,
      versionId: versionId("20"),
      version: 1,
      parentVersionId: null,
      graph: {
        nodes: [node("Research")],
        relationships: [{
          id: "rel_018f0000-0000-7000-8000-000000000030" as never,
          fromNodeId: node("Research").id,
          toNodeId: node("Research").id,
          kind: "invokes",
          executionMode: null,
          contractRef: null,
          description: "self",
        }],
      },
      changeKind: "created",
      restoredFromVersionId: null,
      authoredBy: actor,
      createdAt: at,
      origin: origin("1"),
    })).toThrow(/relationship/u);
  });
});
