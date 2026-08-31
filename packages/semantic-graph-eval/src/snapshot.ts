import {
  SNAPSHOT_PROTOCOL,
  type AcceptedSemanticCandidate,
  type AcceptedSemanticSnapshot,
  type ExperimentConfigurationId,
  type RejectedCandidate,
} from "./contracts.js";
import { compareText } from "./fingerprint.js";

interface SnapshotIdentity {
  fixtureId: string;
  configurationId: ExperimentConfigurationId;
  inputFingerprint: string;
  configurationFingerprint: string;
}

interface AcceptedSnapshotInput extends SnapshotIdentity {
  outcome: "complete" | "partial" | "abstained";
  accepted: AcceptedSemanticCandidate[];
  rejected: RejectedCandidate[];
}

function sortAccepted(
  candidates: AcceptedSemanticCandidate[],
): AcceptedSemanticCandidate[] {
  return [...candidates].sort((left, right) =>
    compareText(
      `${left.sourceAgentId}\u0000${left.targetAgentId}\u0000${left.candidateId}`,
      `${right.sourceAgentId}\u0000${right.targetAgentId}\u0000${right.candidateId}`,
    ),
  );
}

function sortRejected(candidates: RejectedCandidate[]): RejectedCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.index === null && right.index !== null) return -1;
    if (left.index !== null && right.index === null) return 1;
    if (left.index !== right.index)
      return (left.index ?? 0) - (right.index ?? 0);
    return compareText(left.code, right.code);
  });
}

export function createAcceptedSnapshot(
  input: AcceptedSnapshotInput,
): AcceptedSemanticSnapshot {
  return {
    protocol: SNAPSHOT_PROTOCOL,
    fixtureId: input.fixtureId,
    configurationId: input.configurationId,
    inputFingerprint: input.inputFingerprint,
    configurationFingerprint: input.configurationFingerprint,
    attemptStatus: "accepted",
    providerErrorCode: null,
    outcome: input.outcome,
    accepted: sortAccepted(input.accepted),
    rejected: sortRejected(input.rejected),
  };
}

export function createMalformedSnapshot(
  input: SnapshotIdentity & { rejected: RejectedCandidate[] },
): AcceptedSemanticSnapshot {
  return {
    protocol: SNAPSHOT_PROTOCOL,
    fixtureId: input.fixtureId,
    configurationId: input.configurationId,
    inputFingerprint: input.inputFingerprint,
    configurationFingerprint: input.configurationFingerprint,
    attemptStatus: "malformed",
    providerErrorCode: null,
    outcome: "failed",
    accepted: [],
    rejected: sortRejected(input.rejected),
  };
}

export function createProviderFailureSnapshot(
  input: SnapshotIdentity & { errorCode: string },
): AcceptedSemanticSnapshot {
  return {
    protocol: SNAPSHOT_PROTOCOL,
    fixtureId: input.fixtureId,
    configurationId: input.configurationId,
    inputFingerprint: input.inputFingerprint,
    configurationFingerprint: input.configurationFingerprint,
    attemptStatus: "provider-failure",
    providerErrorCode: input.errorCode,
    outcome: "failed",
    accepted: [],
    rejected: [],
  };
}
