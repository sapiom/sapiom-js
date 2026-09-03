import { createHash } from "node:crypto";

import {
  AGENT_MAP_REVISION_SCHEMA_VERSION,
  type AgentMapGraph,
  type AgentMapGraphDigest,
  type AgentMapRevision,
  type AgentMapRevisionId,
  type AgentMapRevisionRef,
  type ConfirmArchitectureFailure,
  type ConfirmArchitectureRequest,
  type MapChangeProposal,
  type MapProposalId,
  type PlannerUserMessageReceipt,
  type PlanningSessionIdentity,
  type StudioProjectId,
} from "../shared/agent-map.js";
import {
  canonicalAgentMapArchitecturePayload,
  canonicalizeAgentMapGraph,
} from "../shared/agent-map-canonical.js";
import {
  isAgentMapBoundedText,
  parseAgentMapGraph,
  parseAgentMapRevision,
  parseAgentMapRevisionRef,
  parseConfirmArchitectureRequest,
  parseMapChangeProposal,
  parsePlannerUserMessageReceipt,
} from "../shared/agent-map-codec.js";

type MapPlannerIdentity = Extract<
  PlanningSessionIdentity,
  { role: "map-planner" }
>;

export interface MaterializeAgentMapRevisionInput {
  proposal: MapChangeProposal;
  request: ConfirmArchitectureRequest;
  receipt: PlannerUserMessageReceipt;
  principal: MapPlannerIdentity;
  revisionId: AgentMapRevisionId;
  revisionNumber: number;
  parentRevisionId: AgentMapRevisionId | null;
  createdAt: string;
}

export type AgentMapConfirmationBoundaryInput =
  | { committedFirst: "proposal-operation" }
  | {
      committedFirst: "confirmation";
      confirmedSource: { proposalId: MapProposalId; version: number };
      operationSource: { proposalId: MapProposalId; version: number };
    };

export type AgentMapConfirmationBoundaryDecision =
  | {
      confirmation: {
        outcome: "failed";
        failure: Extract<
          ConfirmArchitectureFailure,
          { code: "stale_proposal" }
        >;
      };
      proposalOperation: "committed";
    }
  | {
      confirmation: { outcome: "confirmed" };
      proposalOperation: "rebase-eligible" | "stale";
    };

/** A bounded failure whose message never includes caller-controlled values. */
export class AgentMapRevisionContractError extends Error {
  readonly code: ConfirmArchitectureFailure["code"];
  readonly recovery: ConfirmArchitectureFailure["recovery"];

  constructor(readonly failure: ConfirmArchitectureFailure) {
    super(`Agent Map revision rejected: ${failure.code}`);
    this.name = "AgentMapRevisionContractError";
    this.code = failure.code;
    this.recovery = failure.recovery;
  }
}

const reject = (failure: ConfirmArchitectureFailure): never => {
  throw new AgentMapRevisionContractError(failure);
};

/** Hash the exact domain-separated, UTF-8 JSON architecture payload. */
export function digestAgentMapArchitecture(
  projectId: StudioProjectId,
  graphInput: AgentMapGraph,
): AgentMapGraphDigest {
  if (!isAgentMapBoundedText(projectId, 128))
    return reject({ code: "malformed_input", recovery: "reread" });
  let graph: AgentMapGraph;
  try {
    graph = parseAgentMapGraph({
      nodes: graphInput.nodes,
      relationships: graphInput.relationships,
    });
  } catch {
    return reject({ code: "malformed_input", recovery: "reread" });
  }
  const payload = canonicalAgentMapArchitecturePayload(projectId, graph);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex")}` as AgentMapGraphDigest;
}

/**
 * Digest used alongside (project, planner session, request ID) to distinguish
 * an idempotent replay from request-ID reuse with different confirmation data.
 */
export function digestConfirmArchitectureRequest(
  requestInput: ConfirmArchitectureRequest,
): string {
  let request: ConfirmArchitectureRequest;
  try {
    request = parseConfirmArchitectureRequest(requestInput);
  } catch {
    return reject({ code: "malformed_input", recovery: "reread" });
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        "sapiom.agent-map.confirmation-request",
        AGENT_MAP_REVISION_SCHEMA_VERSION,
        request.requestId,
        request.proposalId,
        request.expectedVersion,
        request.expectedDigest,
        request.approvingMessageId,
      ]),
      "utf8",
    )
    .digest("hex");
}

/**
 * Pure description of the confirmation transaction's linearization boundary.
 * `proposal-operation` means the transaction has already validated and
 * committed an operation against the one current proposal source being
 * confirmed. An operation against an older or different proposal cannot
 * inhabit that branch. After confirmation commits, SAP-3063 must still
 * validate an exact-source operation before conservatively rebasing it; this
 * helper keeps only those source-ordering outcomes fixed.
 */
export function classifyAgentMapConfirmationBoundary(
  input: AgentMapConfirmationBoundaryInput,
): AgentMapConfirmationBoundaryDecision {
  if (input.committedFirst === "proposal-operation")
    return {
      confirmation: {
        outcome: "failed",
        failure: { code: "stale_proposal", recovery: "reread" },
      },
      proposalOperation: "committed",
    };
  return {
    confirmation: { outcome: "confirmed" },
    proposalOperation:
      input.operationSource.proposalId === input.confirmedSource.proposalId &&
      input.operationSource.version === input.confirmedSource.version
        ? "rebase-eligible"
        : "stale",
  };
}

/** Validate syntax, graph semantics, and the stored architecture digest. */
export function validateAgentMapRevision(
  value: unknown,
  expectedProjectId: StudioProjectId,
): AgentMapRevision {
  let revision: AgentMapRevision;
  try {
    revision = parseAgentMapRevision(value, expectedProjectId);
  } catch {
    return reject({ code: "invalid_revision_chain", recovery: "reread" });
  }
  let digest: AgentMapGraphDigest;
  try {
    digest = digestAgentMapArchitecture(revision.projectId, revision);
  } catch {
    return reject({ code: "invalid_revision_chain", recovery: "reread" });
  }
  if (digest !== revision.digest)
    return reject({ code: "invalid_revision_chain", recovery: "reread" });
  return revision;
}

/** Validate a complete oldest-to-newest project revision chain. */
export function validateAgentMapRevisionChain(
  values: readonly unknown[],
  expectedProjectId: StudioProjectId,
): AgentMapRevision[] {
  const revisions = values.map((value) =>
    validateAgentMapRevision(value, expectedProjectId),
  );
  const ids = new Set<AgentMapRevisionId>();
  const approvingMessageKeys = new Set<string>();
  const approvedProposalSources = new Set<string>();
  revisions.forEach((revision, index) => {
    const previous = revisions[index - 1];
    const approvedProposalSource = JSON.stringify([
      revision.approval.approvedProposalId,
      revision.approval.approvedProposalVersion,
    ]);
    const approvingMessageKey = JSON.stringify([
      revision.approval.approvingUserId,
      revision.approval.approvingSessionId,
      revision.approval.approvingMessageId,
    ]);
    if (
      ids.has(revision.id) ||
      approvingMessageKeys.has(approvingMessageKey) ||
      approvedProposalSources.has(approvedProposalSource) ||
      revision.revisionNumber !== index + 1 ||
      (index === 0
        ? revision.parentRevisionId !== null
        : revision.parentRevisionId !== previous?.id)
    )
      return reject({ code: "invalid_revision_chain", recovery: "reread" });
    ids.add(revision.id);
    approvingMessageKeys.add(approvingMessageKey);
    approvedProposalSources.add(approvedProposalSource);
  });
  return revisions;
}

/**
 * Promote one exact validated proposal source into an immutable graph snapshot.
 * IDs are copied, never allocated or derived, by this pure boundary.
 */
export function materializeAgentMapRevision(
  input: MaterializeAgentMapRevisionInput,
): AgentMapRevision {
  if (
    input.principal.role !== "map-planner" ||
    !isAgentMapBoundedText(input.principal.projectId, 128) ||
    !isAgentMapBoundedText(input.principal.userId, 256) ||
    !isAgentMapBoundedText(input.principal.sessionId, 256)
  )
    return reject({ code: "malformed_input", recovery: "reread" });
  if (
    input.proposal.projectId !== input.principal.projectId ||
    input.receipt.projectId !== input.principal.projectId
  )
    return reject({ code: "cross_project", recovery: "reread" });

  let request: ConfirmArchitectureRequest;
  let proposal: MapChangeProposal;
  try {
    request = parseConfirmArchitectureRequest(input.request);
    proposal = parseMapChangeProposal(
      input.proposal,
      input.principal.projectId,
    );
  } catch {
    return reject({ code: "malformed_input", recovery: "reread" });
  }
  let receipt: PlannerUserMessageReceipt;
  try {
    receipt = parsePlannerUserMessageReceipt(
      input.receipt,
      input.principal.projectId,
    );
  } catch {
    return reject({ code: "approval_message_invalid", recovery: "ask_again" });
  }

  if (
    request.proposalId !== proposal.id ||
    request.expectedVersion !== proposal.version
  )
    return reject({ code: "stale_proposal", recovery: "reread" });

  let graph: AgentMapGraph;
  try {
    graph = canonicalizeAgentMapGraph(
      parseAgentMapGraph({
        nodes: proposal.nodes,
        relationships: proposal.relationships,
      }),
    );
  } catch {
    return reject({ code: "malformed_input", recovery: "reread" });
  }
  const digest = digestAgentMapArchitecture(proposal.projectId, graph);
  if (request.expectedDigest !== digest)
    return reject({ code: "proposal_digest_mismatch", recovery: "reread" });
  if (
    request.approvingMessageId !== receipt.messageId ||
    receipt.userId !== input.principal.userId ||
    receipt.sessionId !== input.principal.sessionId
  )
    return reject({ code: "approval_message_invalid", recovery: "ask_again" });

  let revisionRef: AgentMapRevisionRef;
  try {
    revisionRef = parseAgentMapRevisionRef({
      id: input.revisionId,
      revisionNumber: input.revisionNumber,
      parentRevisionId: input.parentRevisionId,
      digest,
      createdAt: input.createdAt,
    });
  } catch {
    return reject({ code: "invalid_revision_chain", recovery: "reread" });
  }
  // This is the enforceable temporal lower bound at the pure contract layer.
  // SAP-3065 must additionally prove a trusted read of this exact source.
  if (
    receipt.acceptedAt < proposal.updatedAt ||
    receipt.acceptedAt > revisionRef.createdAt
  )
    return reject({ code: "approval_message_invalid", recovery: "ask_again" });

  return validateAgentMapRevision(
    {
      schemaVersion: AGENT_MAP_REVISION_SCHEMA_VERSION,
      id: revisionRef.id,
      projectId: proposal.projectId,
      revisionNumber: revisionRef.revisionNumber,
      parentRevisionId: revisionRef.parentRevisionId,
      ...graph,
      digest,
      approval: {
        approvedProposalId: proposal.id,
        approvedProposalVersion: proposal.version,
        approvingUserId: receipt.userId,
        approvingSessionId: receipt.sessionId,
        approvingMessageId: receipt.messageId,
        approvedAt: receipt.acceptedAt,
      },
      createdAt: revisionRef.createdAt,
    },
    proposal.projectId,
  );
}
