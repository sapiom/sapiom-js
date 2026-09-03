import { z } from "zod";

import { architectureSourceRefSchema } from "../shared/build-plan-codec.js";

export const BUILD_PLAN_MAX_OPERATIONS = 64;
export const BUILD_PLAN_MAX_ITEMS = 128;
export const BUILD_PLAN_MAX_TEXT = 4_000;
export const BUILD_PLAN_MAX_DIAGNOSTICS = 64;

const UUID_V7 =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const generatedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_${UUID_V7}$`, "u"));
const opaqueId = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value.trim() === value &&
      !value.includes("/") &&
      !value.includes("\\") &&
      ![...value].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 0x1f || point === 0x7f;
      }),
  );
const text = (max = BUILD_PLAN_MAX_TEXT) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);
const positiveInt = z.number().int().safe().positive();
const unique = <T extends z.ZodTypeAny>(
  item: T,
  key: (value: z.infer<T>) => string,
) =>
  z
    .array(item)
    .max(BUILD_PLAN_MAX_ITEMS)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((value, index) => {
        const id = key(value);
        if (seen.has(id))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: "duplicate stable identity",
          });
        seen.add(id);
      });
    });

export const buildPlanIdSchema = generatedId("build-plan");
export const buildPlanRequestIdSchema = opaqueId;
const nodeId = generatedId("node");
const milestoneId = generatedId("milestone");
const criterionId = generatedId("criterion");
const decisionId = generatedId("decision");
const deliverableId = generatedId("deliverable");
const clientRefSchema = opaqueId;
const idOrClientRef = (schema: z.ZodTypeAny) =>
  z.union([schema, z.object({ clientRef: clientRefSchema }).strict()]);

const outcomeSchema = z.object({ summary: text() }).strict();
const constraintSchema = z
  .object({
    constraintId: opaqueId,
    description: text(2_000),
    required: z.boolean(),
  })
  .strict();
const criterionSchema = z
  .object({
    criterionId,
    ordinal: positiveInt,
    description: text(2_000),
    verification: text(2_000),
  })
  .strict();
const decisionSchema = z
  .object({
    decisionId,
    question: text(2_000),
    required: z.boolean(),
    status: z.enum(["open", "resolved"]),
    resolution: text(2_000).nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    if ((decision.status === "resolved") !== (decision.resolution !== null))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "decision status and resolution must agree",
      });
  });
const milestoneSchema = z
  .object({
    milestoneId,
    ordinal: positiveInt,
    title: text(240),
    outcome: text(2_000),
    dependsOn: unique(milestoneId, (id) => id),
  })
  .strict();
const repositoryIntentSchema = z
  .object({
    repositoryIntentId: opaqueId,
    plannedAgentId: nodeId,
    action: z.enum(["create", "bind", "reuse"]),
    repositoryName: text(240),
    notes: text(2_000),
  })
  .strict();
const deliverableSchema = z
  .object({
    deliverableId,
    description: text(2_000),
    artifactNodeIds: unique(nodeId, (id) => id),
    acceptanceCriterionIds: unique(criterionId, (id) => id),
  })
  .strict();
const createCriterionSchema = z
  .object({
    clientRef: clientRefSchema,
    ordinal: positiveInt,
    description: text(2_000),
    verification: text(2_000),
  })
  .strict();
const createDecisionSchema = z
  .object({
    clientRef: clientRefSchema,
    question: text(2_000),
    required: z.boolean(),
    status: z.enum(["open", "resolved"]),
    resolution: text(2_000).nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    if ((decision.status === "resolved") !== (decision.resolution !== null))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "decision status and resolution must agree",
      });
  });
const createAssignmentSchema = z
  .object({
    plannedAgentId: nodeId,
    mission: text(),
    scope: z
      .object({
        inScope: unique(text(2_000), (value) => value),
        nonGoals: unique(text(2_000), (value) => value),
      })
      .strict(),
    deliverables: unique(
      z
        .object({
          clientRef: clientRefSchema,
          description: text(2_000),
          artifactNodeIds: unique(nodeId, (id) => id),
          acceptanceCriterionRefs: unique(
            idOrClientRef(criterionId),
            (value) =>
              typeof value === "string" ? value : `client:${value.clientRef}`,
          ),
        })
        .strict(),
      (value) => value.clientRef,
    ),
    constraints: unique(constraintSchema, (value) => value.constraintId),
    acceptanceCriteria: unique(
      createCriterionSchema,
      (value) => value.clientRef,
    ),
    milestoneRefs: unique(idOrClientRef(milestoneId), (value) =>
      typeof value === "string" ? value : `client:${value.clientRef}`,
    ),
    unresolvedDecisions: unique(
      createDecisionSchema,
      (value) => value.clientRef,
    ),
  })
  .strict();
const assignmentSchema = z
  .object({
    plannedAgentId: nodeId,
    mission: text(),
    scope: z
      .object({
        inScope: unique(text(2_000), (value) => value),
        nonGoals: unique(text(2_000), (value) => value),
      })
      .strict(),
    deliverables: unique(deliverableSchema, (value) => value.deliverableId),
    constraints: unique(constraintSchema, (value) => value.constraintId),
    acceptanceCriteria: unique(criterionSchema, (value) => value.criterionId),
    milestoneIds: unique(milestoneId, (id) => id),
    unresolvedDecisions: unique(decisionSchema, (value) => value.decisionId),
  })
  .strict();

export const buildPlanOperationSchema = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("set-project-outcome"), outcome: outcomeSchema })
    .strict(),
  z
    .object({ op: z.literal("upsert-milestone"), milestone: milestoneSchema })
    .strict(),
  z
    .object({
      op: z.literal("create-milestone"),
      clientRef: clientRefSchema,
      milestone: z
        .object({
          ordinal: positiveInt,
          title: text(240),
          outcome: text(2_000),
          dependsOn: unique(idOrClientRef(milestoneId), (value) =>
            typeof value === "string" ? value : `client:${value.clientRef}`,
          ),
        })
        .strict(),
    })
    .strict(),
  z.object({ op: z.literal("remove-milestone"), milestoneId }).strict(),
  z
    .object({
      op: z.literal("set-shared-constraints"),
      constraints: unique(constraintSchema, (value) => value.constraintId),
    })
    .strict(),
  z
    .object({
      op: z.literal("set-repository-intents"),
      repositories: unique(
        repositoryIntentSchema,
        (value) => value.repositoryIntentId,
      ),
    })
    .strict(),
  z
    .object({
      op: z.literal("set-integration-criteria"),
      criteria: unique(criterionSchema, (value) => value.criterionId),
    })
    .strict(),
  z
    .object({
      op: z.literal("create-integration-criterion"),
      criterion: createCriterionSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("upsert-agent-assignment"),
      assignment: assignmentSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("create-agent-assignment"),
      assignment: createAssignmentSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("remove-agent-assignment"),
      plannedAgentId: nodeId,
    })
    .strict(),
  z
    .object({ op: z.literal("upsert-decision"), decision: decisionSchema })
    .strict(),
  z
    .object({
      op: z.literal("create-decision"),
      decision: createDecisionSchema,
    })
    .strict(),
  z.object({ op: z.literal("remove-decision"), decisionId }).strict(),
]);

const mutationFields = {
  schemaVersion: z.literal(1),
  planId: buildPlanIdSchema.nullable(),
  expectedPlanVersion: positiveInt.nullable(),
  expectedSource: architectureSourceRefSchema,
  operations: z
    .array(buildPlanOperationSchema)
    .min(1)
    .max(BUILD_PLAN_MAX_OPERATIONS),
};

export const buildPlanReadInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    plan: z
      .object({ planId: buildPlanIdSchema, version: positiveInt })
      .strict()
      .optional(),
    include: z
      .array(
        z.enum([
          "plan",
          "assignment-intents",
          "brief-summaries",
          "diagnostics",
          "history-summary",
        ]),
      )
      .max(5)
      .optional(),
  })
  .strict();

export const buildPlanValidateRequestSchema = z.object(mutationFields).strict();
export const buildPlanApplyRequestSchema = z
  .object({ ...mutationFields, requestId: buildPlanRequestIdSchema })
  .strict();

export const rebaseResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("remap-agent"),
      fromPlannedAgentId: nodeId,
      toPlannedAgentId: nodeId,
    })
    .strict(),
  z
    .object({ kind: z.literal("remove-assignment"), plannedAgentId: nodeId })
    .strict(),
  z
    .object({
      kind: z.literal("remap-repository-intent"),
      repositoryIntentId: opaqueId,
      toPlannedAgentId: nodeId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove-repository-intent"),
      repositoryIntentId: opaqueId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remap-artifact-reference"),
      plannedAgentId: nodeId,
      deliverableId,
      fromNodeId: nodeId,
      toNodeId: nodeId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove-artifact-reference"),
      plannedAgentId: nodeId,
      deliverableId,
      nodeId,
    })
    .strict(),
]);

export const buildPlanRebaseRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: buildPlanIdSchema,
    expectedPlanVersion: positiveInt,
    fromSource: architectureSourceRefSchema,
    toSource: architectureSourceRefSchema,
    requestId: buildPlanRequestIdSchema,
    resolutions: z.array(rebaseResolutionSchema).max(BUILD_PLAN_MAX_ITEMS),
  })
  .strict();

export type BuildPlanOperation = z.infer<typeof buildPlanOperationSchema>;
export type BuildPlanReadInput = z.infer<typeof buildPlanReadInputSchema>;
export type BuildPlanValidateRequest = z.infer<
  typeof buildPlanValidateRequestSchema
>;
export type BuildPlanApplyRequest = z.infer<typeof buildPlanApplyRequestSchema>;
export type BuildPlanRebaseRequest = z.infer<
  typeof buildPlanRebaseRequestSchema
>;
