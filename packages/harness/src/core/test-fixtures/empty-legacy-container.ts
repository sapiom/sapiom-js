/** Exact empty shapes written by the historical wrapped-format-2 stores. */
export function emptyLegacyContainer(
  projectId: string,
  variant: 9 | 10 | 13 | 14 = 13,
) {
  return {
    storageSchemaVersion: 2,
    workspace: {
      projectId,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
    proposal: null,
    receipts: [],
    buildPlanning: {
      schemaVersion: 1,
      planId: null,
      currentPlanVersion: null,
      planVersions: [],
      currentBriefByAgentId: {},
      briefVersionsById: {},
      assignmentByAgentId: {},
      submissionsByAssignmentId: {},
      idempotencyReceipts: [],
      ...(variant >= 10 ? { idempotencyTombstones: [] } : {}),
      ...(variant >= 13
        ? {
            fanoutApprovals: [],
            builderBindingsByAssignmentId: {},
            planningSubmissionReceipts: [],
          }
        : {}),
      ...(variant === 14 ? { fanoutConsents: [] } : {}),
    },
  };
}
