import {
  modelCandidateSchema,
  semanticModelEnvelopeSchema,
  type AcceptedSemanticCandidate,
  type AcceptedSemanticSnapshot,
  type ProviderAttempt,
  type ProviderRequest,
  type RejectedCandidate,
  type RejectionCode,
} from "./contracts.js";
import { fingerprint } from "./fingerprint.js";
import { visiblePacketReferences } from "./packet.js";
import {
  createAcceptedSnapshot,
  createMalformedSnapshot,
  createProviderFailureSnapshot,
} from "./snapshot.js";

function rejection(
  index: number | null,
  code: RejectionCode,
  candidate: unknown,
): RejectedCandidate {
  return {
    index,
    code,
    candidateFingerprint: fingerprint({ candidate }),
  };
}

function pairKey(sourceAgentId: string, targetAgentId: string): string {
  return `${sourceAgentId}\u0000${targetAgentId}`;
}

function candidateIdentity(
  request: ProviderRequest,
  candidate: {
    sourceAgentId: string;
    targetAgentId: string;
    relationship: "feeds";
  },
): string {
  return fingerprint({
    protocol: "semantic-graph-eval.candidate/1",
    inputFingerprint: request.inputFingerprint,
    packetFingerprint: request.packetFingerprint,
    promptFingerprint: request.promptFingerprint,
    configurationFingerprint: request.configurationFingerprint,
    requestedModel: request.requestedModel,
    relationship: candidate.relationship,
    sourceAgentId: candidate.sourceAgentId,
    targetAgentId: candidate.targetAgentId,
  });
}

export function validateProviderAttempt(
  request: ProviderRequest,
  attempt: ProviderAttempt,
): AcceptedSemanticSnapshot {
  const identity = {
    fixtureId: request.fixtureId,
    configurationId: request.configuration.id,
    inputFingerprint: request.inputFingerprint,
    configurationFingerprint: request.configurationFingerprint,
  };
  if (attempt.status === "failure") {
    return createProviderFailureSnapshot({
      ...identity,
      errorCode: attempt.errorCode,
    });
  }
  const parsedEnvelope = semanticModelEnvelopeSchema.safeParse(
    attempt.rawResponse,
  );
  if (!parsedEnvelope.success) {
    return createMalformedSnapshot({
      ...identity,
      rejected: [rejection(null, "malformed-output", attempt.rawResponse)],
    });
  }
  const envelope = parsedEnvelope.data;
  if (envelope.outcome === "abstained" && envelope.candidates.length > 0) {
    return createMalformedSnapshot({
      ...identity,
      rejected: [
        rejection(null, "abstained-with-candidates", attempt.rawResponse),
      ],
    });
  }

  const knownAgents = new Set(
    request.packet.agents.map((agent) => agent.agentId),
  );
  const visibleRefs = visiblePacketReferences(request.packet);
  const provenFeedPairs = new Set(
    request.packet.provenRelationships
      .filter((relationship) => relationship.relationship === "feeds")
      .map((relationship) =>
        pairKey(relationship.sourceAgentId, relationship.targetAgentId),
      ),
  );
  const seenPairs = new Set<string>();
  const accepted: AcceptedSemanticCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  envelope.candidates.forEach((rawCandidate, index) => {
    const parsedCandidate = modelCandidateSchema.safeParse(rawCandidate);
    if (!parsedCandidate.success) {
      rejected.push(rejection(index, "invalid-candidate", rawCandidate));
      return;
    }
    const candidate = parsedCandidate.data;
    const key = pairKey(candidate.sourceAgentId, candidate.targetAgentId);
    if (seenPairs.has(key)) {
      rejected.push(rejection(index, "duplicate-candidate", rawCandidate));
      return;
    }
    if (
      !knownAgents.has(candidate.sourceAgentId) ||
      !knownAgents.has(candidate.targetAgentId)
    ) {
      rejected.push(rejection(index, "unknown-endpoint", rawCandidate));
      return;
    }
    if (candidate.sourceAgentId === candidate.targetAgentId) {
      rejected.push(rejection(index, "self-link", rawCandidate));
      return;
    }
    if (provenFeedPairs.has(key)) {
      rejected.push(rejection(index, "already-proven", rawCandidate));
      return;
    }
    if (
      new Set(candidate.supportRefs).size !== candidate.supportRefs.length ||
      candidate.supportRefs.some((reference) => !visibleRefs.has(reference))
    ) {
      rejected.push(rejection(index, "fabricated-support-ref", rawCandidate));
      return;
    }
    seenPairs.add(key);
    accepted.push({
      ...candidate,
      candidateId: candidateIdentity(request, candidate),
      supportRefs: [...candidate.supportRefs].sort(),
    });
  });

  return createAcceptedSnapshot({
    ...identity,
    outcome: envelope.outcome,
    accepted,
    rejected,
  });
}
