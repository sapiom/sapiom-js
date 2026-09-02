import { z } from "zod";

import {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  EXECUTION_MODES,
  PLAN_NODE_KINDS,
  RELATIONSHIP_KINDS,
  type MapChangeProposal,
  type ProposalBatchResult,
} from "./agent-map.js";

const UUID_V7 =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const bounded = (maximum = 2_000, empty = false) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) =>
        (empty || value.length > 0) &&
        value === value.trim() &&
        ![...value].some(
          (character) => (character.codePointAt(0) ?? 0) <= 0x1f,
        ),
    );
const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_${UUID_V7}$`, "u"));
const nodeId = id("node");
const relationshipId = id("rel");
const proposalId = id("proposal");
const operationId = id("operation");
const timestamp = z.string().datetime({ offset: false });
const contractRefs = z
  .array(bounded(512))
  .max(64)
  .refine((values) => new Set(values).size === values.length);

const node = z
  .object({
    id: nodeId,
    kind: z.enum(PLAN_NODE_KINDS),
    name: bounded(160),
    purpose: bounded(2_000),
    ownerAgentId: nodeId.nullable(),
    contractRefs,
  })
  .strict();

const relationship = z
  .object({
    id: relationshipId,
    fromNodeId: nodeId,
    toNodeId: nodeId,
    kind: z.enum(RELATIONSHIP_KINDS),
    executionMode: z.enum(EXECUTION_MODES).nullable(),
    contractRef: bounded(512).nullable(),
    description: bounded(2_000, true),
  })
  .strict();

const nodeChanges = z
  .object({
    name: bounded(160).optional(),
    purpose: bounded(2_000).optional(),
    contractRefs: contractRefs.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const relationshipChanges = z
  .object({
    description: bounded(2_000, true).optional(),
    executionMode: z.enum(EXECUTION_MODES).nullable().optional(),
    contractRef: bounded(512).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const persistedMapOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add-node"), node }).strict(),
  z
    .object({ kind: z.literal("update-node"), nodeId, changes: nodeChanges })
    .strict(),
  z.object({ kind: z.literal("remove-node"), nodeId }).strict(),
  z.object({ kind: z.literal("add-relationship"), relationship }).strict(),
  z
    .object({
      kind: z.literal("update-relationship"),
      relationshipId,
      changes: relationshipChanges,
    })
    .strict(),
  z.object({ kind: z.literal("remove-relationship"), relationshipId }).strict(),
]);

const assignment = z.union([
  z.object({ kind: z.literal("planned"), agentId: bounded(256) }).strict(),
  z.object({ kind: z.literal("unplanned") }).strict(),
]);
export const proposalActorSchema = z.union([
  z
    .object({
      userId: bounded(256),
      sessionId: bounded(256),
      role: z.literal("map-planner"),
      assignment: z.null(),
    })
    .strict(),
  z
    .object({
      userId: bounded(256),
      sessionId: bounded(256),
      role: z.literal("agent-builder"),
      assignment,
    })
    .strict(),
]);

const operationRecord = z
  .object({
    id: operationId,
    requestId: bounded(128),
    acceptedVersion: z.number().int().positive(),
    operation: persistedMapOperationSchema,
    actor: proposalActorSchema,
    acceptedAt: timestamp,
  })
  .strict();

export const acceptedProposalDeltaSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MAP_PROPOSAL_SCHEMA_VERSION),
    projectId: bounded(128),
    proposalId,
    fromVersion: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    operationIds: z.array(operationId).min(1),
    operations: z.array(persistedMapOperationSchema).min(1),
    actor: proposalActorSchema,
    acceptedAt: timestamp,
  })
  .strict()
  .refine(
    (value) =>
      value.version === value.fromVersion + 1 &&
      value.operationIds.length === value.operations.length,
  );

export const proposalBatchResultSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MAP_PROPOSAL_SCHEMA_VERSION),
    proposalId,
    version: z.number().int().positive(),
    operationIds: z.array(operationId).min(1),
    allocatedNodeIds: z.record(bounded(128), nodeId),
    allocatedRelationshipIds: z.record(bounded(128), relationshipId),
    delta: acceptedProposalDeltaSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.proposalId === value.delta.proposalId &&
      value.version === value.delta.version &&
      JSON.stringify(value.operationIds) ===
        JSON.stringify(value.delta.operationIds),
  );

export const mapChangeProposalSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MAP_PROPOSAL_SCHEMA_VERSION),
    id: proposalId,
    projectId: bounded(128),
    baseRevisionId: bounded(256).nullable(),
    version: z.number().int().positive(),
    nodes: z.array(node),
    relationships: z.array(relationship),
    history: z.array(operationRecord).min(1),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    const nodeIds = value.nodes.map(({ id }) => id);
    const relationshipIds = value.relationships.map(({ id }) => id);
    const operationIds = value.history.map(({ id }) => id);
    if (
      new Set(nodeIds).size !== nodeIds.length ||
      new Set(relationshipIds).size !== relationshipIds.length ||
      new Set(operationIds).size !== operationIds.length ||
      value.history.some((record) => record.acceptedVersion > value.version) ||
      value.history.at(-1)?.acceptedVersion !== value.version
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inconsistent proposal",
      });
  });

export const proposalReceiptSchema = z
  .object({
    sessionId: bounded(256),
    requestId: bounded(128),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    result: proposalBatchResultSchema,
    touchSet: z
      .object({
        entityKeys: z.array(bounded(1_000, true)),
        semanticRelationshipKeys: z.array(bounded(2_000, true)),
      })
      .strict(),
  })
  .strict();

export function parseMapChangeProposal(
  value: unknown,
  projectId: string,
  activeProposalId: string,
): MapChangeProposal {
  const parsed = mapChangeProposalSchema.parse(value);
  if (parsed.projectId !== projectId || parsed.id !== activeProposalId)
    throw new Error("proposal identity mismatch");
  return parsed as MapChangeProposal;
}

export function parseProposalBatchResult(value: unknown): ProposalBatchResult {
  return proposalBatchResultSchema.parse(value) as ProposalBatchResult;
}
