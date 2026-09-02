import { z } from "zod";

import {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  EXECUTION_MODES,
  PLAN_NODE_KINDS,
  RELATIONSHIP_KINDS,
  type DraftRef,
  type MapOperationInput,
  type MapProposalId,
  type PlanNodeId,
  type PlanRelationshipId,
  type ProposalBatchRequest,
  type ProposalValidationIssue,
  type ProposalValidationResult,
} from "../shared/agent-map.js";

const UUID_V7 =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const boundedText = (maximum: number, allowEmpty = false) =>
  z
    .string()
    .max(maximum)
    .refine((value) => (allowEmpty ? true : value.length > 0))
    .refine((value) => value.trim() === value)
    .refine((value) => !hasControlCharacter(value));

const opaqueId = <T>(prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_${UUID_V7}$`, "u"))
    .transform((value) => value as T);

export const planNodeIdSchema = opaqueId<PlanNodeId>("node");
export const planRelationshipIdSchema = opaqueId<PlanRelationshipId>("rel");
export const mapProposalIdSchema = opaqueId<MapProposalId>("proposal");
export const draftRefSchema = boundedText(128).transform(
  (value) => value as DraftRef,
);

const contractRefSchema = boundedText(512);
const contractRefsSchema = z
  .array(contractRefSchema)
  .max(64)
  .refine((values) => new Set(values).size === values.length);

const stripUndefinedProperties = <T extends Record<string, unknown>>(
  value: T,
): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;

export const nodeRefSchema = z.union([
  z.object({ nodeId: planNodeIdSchema }).strict(),
  z.object({ draftRef: draftRefSchema }).strict(),
]);

const nodeChangesSchema = z
  .object({
    name: boundedText(160).optional(),
    purpose: boundedText(2_000).optional(),
    contractRefs: contractRefsSchema.optional(),
  })
  .strict()
  .transform(stripUndefinedProperties)
  .refine((changes) => Object.keys(changes).length > 0);

const relationshipChangesSchema = z
  .object({
    description: boundedText(2_000, true).optional(),
    executionMode: z.enum(EXECUTION_MODES).nullable().optional(),
    contractRef: contractRefSchema.nullable().optional(),
  })
  .strict()
  .transform(stripUndefinedProperties)
  .refine((changes) => Object.keys(changes).length > 0);

const addNodeSchema = z
  .object({
    kind: z.literal("add-node"),
    draftRef: draftRefSchema,
    node: z
      .object({
        kind: z.enum(PLAN_NODE_KINDS),
        name: boundedText(160),
        purpose: boundedText(2_000),
        ownerAgent: nodeRefSchema.nullable(),
        contractRefs: contractRefsSchema,
      })
      .strict(),
  })
  .strict();

const updateNodeSchema = z
  .object({
    kind: z.literal("update-node"),
    nodeId: planNodeIdSchema,
    changes: nodeChangesSchema,
  })
  .strict();

const removeNodeSchema = z
  .object({ kind: z.literal("remove-node"), nodeId: planNodeIdSchema })
  .strict();

const addRelationshipSchema = z
  .object({
    kind: z.literal("add-relationship"),
    draftRef: draftRefSchema,
    relationship: z
      .object({
        from: nodeRefSchema,
        to: nodeRefSchema,
        kind: z.enum(RELATIONSHIP_KINDS),
        executionMode: z.enum(EXECUTION_MODES).nullable(),
        contractRef: contractRefSchema.nullable(),
        description: boundedText(2_000, true),
      })
      .strict(),
  })
  .strict();

const updateRelationshipSchema = z
  .object({
    kind: z.literal("update-relationship"),
    relationshipId: planRelationshipIdSchema,
    changes: relationshipChangesSchema,
  })
  .strict();

const removeRelationshipSchema = z
  .object({
    kind: z.literal("remove-relationship"),
    relationshipId: planRelationshipIdSchema,
  })
  .strict();

export const mapOperationInputSchema = z.discriminatedUnion("kind", [
  addNodeSchema,
  updateNodeSchema,
  removeNodeSchema,
  addRelationshipSchema,
  updateRelationshipSchema,
  removeRelationshipSchema,
]);

export const proposalBatchRequestSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MAP_PROPOSAL_SCHEMA_VERSION),
    proposalId: mapProposalIdSchema.nullable(),
    expectedVersion: z.number().int().nonnegative(),
    requestId: boundedText(128),
    operations: z.array(mapOperationInputSchema).min(1).max(256),
  })
  .strict();

const IMMUTABLE_OR_AUTHORITY_FIELDS = new Set([
  "id",
  "nodeId",
  "relationshipId",
  "kind",
  "ownerAgentId",
  "ownerAgent",
  "from",
  "to",
  "fromNodeId",
  "toNodeId",
  "binding",
  "bindings",
  "projectId",
  "userId",
  "sessionId",
  "role",
  "assignment",
  "actor",
]);

function operationIndexForPath(path: Array<string | number>): number | null {
  return path[0] === "operations" && typeof path[1] === "number"
    ? path[1]
    : null;
}

/** Translate Zod details without returning values, prose, or unbounded messages. */
export function proposalSchemaIssues(
  error: z.ZodError,
): ProposalValidationIssue[] {
  const translated: ProposalValidationIssue[] = [];
  const pathsWithUnknownKeys = new Set(
    error.issues
      .filter((issue) => issue.code === "unrecognized_keys")
      .map((issue) => JSON.stringify(issue.path)),
  );

  for (const issue of error.issues.slice(0, 32)) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys.slice(0, 16)) {
        translated.push({
          code: IMMUTABLE_OR_AUTHORITY_FIELDS.has(key)
            ? "immutable_field"
            : "malformed_input",
          operationIndex: operationIndexForPath(issue.path),
          path: [...issue.path, key],
          recovery: "correct",
        });
      }
      continue;
    }

    // A strict object with only forbidden keys also fails its non-empty
    // refinement. The field-addressable unknown-key issue is the useful one.
    if (
      issue.code === "custom" &&
      pathsWithUnknownKeys.has(JSON.stringify(issue.path))
    ) {
      continue;
    }

    translated.push({
      code:
        issue.path[0] === "operations" && issue.code === "too_small"
          ? "empty_batch"
          : "malformed_input",
      operationIndex: operationIndexForPath(issue.path),
      path: issue.path,
      recovery: "correct",
    });
  }

  return translated;
}

/** Strict caller boundary for both MCP validation and mutation tools. */
export function parseProposalBatchRequest(
  input: unknown,
): ProposalValidationResult<ProposalBatchRequest> {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    (input as { schemaVersion?: unknown }).schemaVersion !==
      AGENT_MAP_PROPOSAL_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "unsupported_schema",
          operationIndex: null,
          path: ["schemaVersion"],
          recovery: "correct",
        },
      ],
    };
  }

  const parsed = proposalBatchRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: proposalSchemaIssues(parsed.error) };
  }

  return {
    ok: true,
    value: parsed.data as ProposalBatchRequest & {
      operations: MapOperationInput[];
    },
  };
}
