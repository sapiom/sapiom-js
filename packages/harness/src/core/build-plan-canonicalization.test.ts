import { describe, expect, it } from "vitest";

import type { AgentMapRevisionId } from "../shared/build-plan.js";
import { makeBrief, makePlan } from "./build-plan.test-support.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";

describe("build planning canonical digests", () => {
  it("matches the versioned golden digest vectors", () => {
    const plan = makePlan();
    const brief = makeBrief(plan);

    expect(plan.semanticDigest).toBe(
      "sha256:93e773caa817b2dd7127a347067f679eb67b2ee1930285ae535a4a0df8a84770",
    );
    expect(plan.recordDigest).toBe(
      "sha256:c1cebc5b437ab52c744b2fe058264510a26e11fe02c24d048c9e6ad52844325d",
    );
    expect(brief.semanticDigest).toBe(
      "sha256:b017596fdf7600bd1a5d3637399776dca020c0da3bd1d4a59036a09179a38994",
    );
    expect(brief.recordDigest).toBe(
      "sha256:c96971676b99b99d2a2b0fe1c5f277796512f853494d15f6d3b504b931cb9cf5",
    );
  });

  it("separates semantic identity from record/source metadata", () => {
    const proposal = makePlan();
    const rebound = makePlan({
      changeKind: "source-rebound",
      source: {
        kind: "revision",
        revisionId:
          "revision_00000000-0000-7000-8000-000000000006" as AgentMapRevisionId,
        revisionNumber: 1,
        graphDigest: proposal.source.graphDigest,
      },
      authoredBy: {
        userId: "user-2",
        sessionId: "session-2",
        role: "map-planner",
      },
      createdAt: "2026-09-03T10:00:00.000Z",
    });

    expect(computeBuildPlanSemanticDigest(rebound)).toBe(
      proposal.semanticDigest,
    );
    expect(computeBuildPlanRecordDigest(rebound)).not.toBe(
      proposal.recordDigest,
    );
  });

  it("changes semantic digests for meaning and preserves set ordering", () => {
    const plan = makePlan();
    const reordered = makePlan({
      assignments: [
        {
          ...plan.assignments[0]!,
          scope: { inScope: ["B", "A"], nonGoals: ["Y", "X"] },
        },
      ],
    });
    const sameReordered = makePlan({
      assignments: [
        {
          ...plan.assignments[0]!,
          scope: { inScope: ["A", "B"], nonGoals: ["X", "Y"] },
        },
      ],
    });
    const edited = makePlan({ outcome: { summary: "A different outcome" } });

    expect(reordered.semanticDigest).toBe(sameReordered.semanticDigest);
    expect(edited.semanticDigest).not.toBe(plan.semanticDigest);
  });

  it("keeps brief semantics stable across exact source-only rebinding", () => {
    const plan = makePlan();
    const brief = makeBrief(plan);
    const rebound = {
      ...brief,
      source: {
        kind: "revision" as const,
        revisionId:
          "revision_00000000-0000-7000-8000-000000000006" as AgentMapRevisionId,
        revisionNumber: 1,
        graphDigest: brief.source.graphDigest,
      },
      createdAt: "2026-09-03T10:00:00.000Z",
    };

    expect(computeAgentBriefSemanticDigest(rebound)).toBe(brief.semanticDigest);
    expect(computeAgentBriefRecordDigest(rebound)).not.toBe(brief.recordDigest);
  });
});
