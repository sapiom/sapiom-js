import { describe, expect, it } from "vitest";

import type { PlanNodeId } from "./agent-map.js";
import {
  canonicalWorkstreamScopes,
  canonicalizeAgentBriefFocusScope,
  computeAgentBriefId,
  computeAgentBriefScopeKey,
} from "./agent-brief.js";

const projectId = "project_018f0000-0000-7000-8000-000000000001";
const research = "node_018f0000-0000-7000-8000-000000000010" as PlanNodeId;
const publishing = "node_018f0000-0000-7000-8000-000000000011" as PlanNodeId;

describe("role-neutral brief focus identity", () => {
  it("is stable across exact map and plan versions", () => {
    const scope = { family: "canonical-workstream" as const, plannedAgentId: research };
    expect(computeAgentBriefScopeKey(projectId, scope)).toBe(
      computeAgentBriefScopeKey(projectId, canonicalizeAgentBriefFocusScope(scope)),
    );
    expect(computeAgentBriefId(projectId, scope)).toBe(computeAgentBriefId(projectId, scope));
  });

  it("separates canonical workstreams, delegations, parents, and projects", () => {
    const canonical = { family: "canonical-workstream" as const, plannedAgentId: research };
    const delegated = {
      family: "ad-hoc-delegation" as const,
      delegationKey: research,
      parentScopeKey: null,
    };
    const nested = { ...delegated, parentScopeKey: computeAgentBriefScopeKey(projectId, canonical) };
    const keys = [
      computeAgentBriefScopeKey(projectId, canonical),
      computeAgentBriefScopeKey(projectId, delegated),
      computeAgentBriefScopeKey(projectId, nested),
      computeAgentBriefScopeKey(`${projectId}-other`, canonical),
    ];
    expect(new Set(keys)).toHaveLength(keys.length);
  });

  it("sorts and deduplicates canonical workstreams by code point", () => {
    expect(canonicalWorkstreamScopes([research, publishing, research])).toEqual([
      { family: "canonical-workstream", plannedAgentId: research },
      { family: "canonical-workstream", plannedAgentId: publishing },
    ]);
  });
});
