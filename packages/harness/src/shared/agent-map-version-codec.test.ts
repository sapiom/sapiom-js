import { describe, expect, it } from "vitest";
import { createAgentMapVersion } from "../core/agent-map-version.js";
import { parseAgentMapVersion } from "./agent-map-version-codec.js";
import type { AgentMapVersionId } from "./agent-map.js";

const projectId = "project_018f0000-0000-4000-8000-000000000001";
const version = () => createAgentMapVersion({
  projectId, versionId: "mapv_018f0000-0000-7000-8000-000000000001" as AgentMapVersionId,
  version: 1, parentVersionId: null, graph: { nodes: [], relationships: [] },
  changeKind: "created", restoredFromVersionId: null, authoredBy: { userId: "user", sessionId: "session" },
  createdAt: "2026-09-04T12:00:00.000Z",
  origin: { kind: "request", requestDigest: `sha256:${"1".repeat(64)}`, operationIds: [], touchKeys: [] },
});

describe("strict immutable map version decoder", () => {
  it("accepts an intact exact-project version and returns a detached value", () => {
    const source = version();
    const parsed = parseAgentMapVersion(source, projectId);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.graph).not.toBe(source.graph);
  });

  it.each([
    ["unknown keys", { extra: true }],
    ["unknown schema", { schemaVersion: 2 }],
    ["cross-project identity", { projectId: "project_018f0000-0000-4000-8000-000000000002" }],
    ["forged graph digest", { contentDigest: `sha256:${"0".repeat(64)}` }],
    ["forged record digest", { recordDigest: `sha256:${"0".repeat(64)}` }],
    ["unknown actor field", { authoredBy: { userId: "user", sessionId: "session", extra: true } }],
    ["restore without source", { changeKind: "restored" }],
    ["source without restore", { restoredFromVersionId: "mapv_018f0000-0000-7000-8000-000000000002" }],
  ])("rejects %s", (_label, changes) => {
    expect(() => parseAgentMapVersion({ ...version(), ...changes }, projectId)).toThrow();
  });
});
