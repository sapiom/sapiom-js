import { z } from "zod";

import {
  AGENT_BRIEF_VERSION_HISTORY_LIMIT,
  architectureSourceRefsEqual,
  BUILD_PLAN_ID_MAPPING_LIMIT,
  BUILD_PLAN_VERSION_HISTORY_LIMIT,
  PLANNING_SUBMISSION_HISTORY_LIMIT,
  type AgentBriefVersionRecord,
  type ArchitectureSourceRef,
  type BuilderPlanningSubmission,
  type BuildPlanningAggregateV1,
  type PlanningAssignmentRecord,
  type ProjectBuildPlanVersion,
} from "./build-plan.js";

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
const projectId = z
  .string()
  .regex(
    /^project_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const nodeId = generatedId("node");
const relationshipId = generatedId("rel");
const operationId = generatedId("operation");
const version = z.number().int().safe().positive();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const point = character.codePointAt(0) ?? 0;
          return (
            (point <= 0x1f &&
              point !== 0x09 &&
              point !== 0x0a &&
              point !== 0x0d) ||
            point === 0x7f ||
            (point >= 0xd800 && point <= 0xdfff)
          );
        }),
    );
const unique = <T extends z.ZodTypeAny>(
  schema: T,
  key: (entry: z.infer<T>) => string,
) =>
  z
    .array(schema)
    .max(256)
    .superRefine((entries, context) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const id = key(entry);
        if (seen.has(id))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: "duplicate identity",
          });
        seen.add(id);
      });
    });
const hasDuplicateOrdinals = (entries: readonly { ordinal: number }[]) =>
  new Set(entries.map((entry) => entry.ordinal)).size !== entries.length;

export const architectureSourceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("proposal"),
      proposalId: generatedId("proposal"),
      version,
      graphDigest: digest,
    })
    .strict(),
  z
    .object({
      kind: z.literal("revision"),
      revisionId: generatedId("revision"),
      revisionNumber: version,
      graphDigest: digest,
    })
    .strict(),
]);

const buildPlanRefSchema = z
  .object({
    planId: generatedId("build-plan"),
    version,
    semanticDigest: digest,
  })
  .strict();
const briefRefSchema = z
  .object({
    briefId: generatedId("brief"),
    version,
    semanticDigest: digest,
  })
  .strict();
const actorSchema = z
  .object({
    userId: opaqueId,
    sessionId: opaqueId,
    role: z.enum(["map-planner", "agent-builder"]),
  })
  .strict();
const scopeSchema = z
  .object({
    inScope: unique(text(2_000), (entry) => entry),
    nonGoals: unique(text(2_000), (entry) => entry),
  })
  .strict();
const milestoneSchema = z
  .object({
    milestoneId: generatedId("milestone"),
    ordinal: version,
    title: text(240),
    outcome: text(2_000),
    dependsOn: unique(generatedId("milestone"), (entry) => entry),
  })
  .strict();
const constraintSchema = z
  .object({
    constraintId: opaqueId,
    description: text(2_000),
    required: z.boolean(),
  })
  .strict();
const criterionSchema = z
  .object({
    criterionId: generatedId("criterion"),
    ordinal: version,
    description: text(2_000),
    verification: text(2_000),
  })
  .strict();
const decisionSchema = z
  .object({
    decisionId: generatedId("decision"),
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
        message: "decision status mismatch",
      });
  });
const deliverableSchema = z
  .object({
    deliverableId: generatedId("deliverable"),
    description: text(2_000),
    artifactNodeIds: unique(nodeId, (entry) => entry),
    acceptanceCriterionIds: unique(generatedId("criterion"), (entry) => entry),
  })
  .strict();
const assignmentIntentSchema = z
  .object({
    plannedAgentId: nodeId,
    mission: text(4_000),
    scope: scopeSchema,
    deliverables: unique(deliverableSchema, (entry) => entry.deliverableId),
    constraints: unique(constraintSchema, (entry) => entry.constraintId),
    acceptanceCriteria: unique(criterionSchema, (entry) => entry.criterionId),
    milestoneIds: unique(generatedId("milestone"), (entry) => entry),
    unresolvedDecisions: unique(decisionSchema, (entry) => entry.decisionId),
  })
  .strict();

export const projectBuildPlanVersionSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId,
    planId: generatedId("build-plan"),
    version,
    parentVersion: version.nullable(),
    changeKind: z.enum([
      "created",
      "edited",
      "recompiled",
      "source-rebound",
      "restored",
    ]),
    source: architectureSourceRefSchema,
    outcome: z.object({ summary: text(4_000) }).strict(),
    milestones: unique(milestoneSchema, (entry) => entry.milestoneId),
    sharedConstraints: unique(constraintSchema, (entry) => entry.constraintId),
    repositoryIntents: unique(
      z
        .object({
          repositoryIntentId: opaqueId,
          plannedAgentId: nodeId,
          action: z.enum(["create", "bind", "reuse"]),
          repositoryName: text(240),
          notes: text(2_000),
        })
        .strict(),
      (entry) => entry.repositoryIntentId,
    ),
    integrationCriteria: unique(criterionSchema, (entry) => entry.criterionId),
    assignments: unique(
      assignmentIntentSchema,
      (entry) => entry.plannedAgentId,
    ),
    unresolvedDecisions: unique(decisionSchema, (entry) => entry.decisionId),
    semanticDigest: digest,
    recordDigest: digest,
    authoredBy: actorSchema,
    createdAt: timestamp,
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.version === 1 && plan.parentVersion !== null)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentVersion"],
        message: "first version has no parent",
      });
    if (plan.version > 1 && plan.parentVersion !== plan.version - 1)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentVersion"],
        message: "parent must be previous version",
      });
    if (
      hasDuplicateOrdinals(plan.milestones) ||
      hasDuplicateOrdinals(plan.integrationCriteria) ||
      plan.assignments.some((assignment) =>
        hasDuplicateOrdinals(assignment.acceptanceCriteria),
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ordinal"],
        message: "ordered records require unique ordinals",
      });
    const milestoneIds = new Set(
      plan.milestones.map((milestone) => milestone.milestoneId),
    );
    plan.milestones.forEach((milestone, index) => {
      if (
        milestone.dependsOn.includes(milestone.milestoneId) ||
        milestone.dependsOn.some((id) => !milestoneIds.has(id))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["milestones", index, "dependsOn"],
          message: "invalid milestone dependency",
        });
    });
    plan.assignments.forEach((assignment, index) => {
      if (assignment.milestoneIds.some((id) => !milestoneIds.has(id)))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assignments", index, "milestoneIds"],
          message: "unknown milestone",
        });
      const criterionIds = new Set(
        assignment.acceptanceCriteria.map((entry) => entry.criterionId),
      );
      if (
        assignment.deliverables.some((deliverable) =>
          deliverable.acceptanceCriterionIds.some(
            (id) => !criterionIds.has(id),
          ),
        )
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assignments", index, "deliverables"],
          message: "unknown acceptance criterion",
        });
    });
  });

const contractPortSchema = z
  .object({
    contractId: opaqueId,
    nodeId,
    relationshipIds: unique(relationshipId, (entry) => entry),
    executionModes: unique(
      z.enum(["synchronous", "asynchronous", "scheduled", "human-triggered"]),
      (entry) => entry,
    ).optional(),
    description: text(2_000),
  })
  .strict();
const dependencySchema = z
  .object({
    dependencyId: generatedId("dependency"),
    kind: z.enum([
      "consumes-output",
      "provides-input",
      "shared-resource",
      "sequence-gate",
      "coordination",
    ]),
    direction: z.enum(["upstream", "downstream", "bidirectional"]),
    counterpartAgentId: nodeId,
    relationshipIds: unique(relationshipId, (entry) => entry),
    contractIds: unique(opaqueId, (entry) => entry),
    requiredByMilestoneIds: unique(generatedId("milestone"), (entry) => entry),
    blocking: z.boolean(),
    description: text(2_000),
  })
  .strict();
const fingerprintSchema = z
  .object({
    kind: z.enum([
      "owned-nodes",
      "relevant-nodes",
      "input-contracts",
      "output-contracts",
      "cross-agent-relationships",
      "shared-resources",
      "milestones",
      "shared-plan-content",
      "assignment-content",
    ]),
    digest,
    nodeIds: unique(nodeId, (entry) => entry),
    relationshipIds: unique(relationshipId, (entry) => entry),
    contractIds: unique(opaqueId, (entry) => entry),
  })
  .strict();

export const agentBriefVersionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId,
    briefId: generatedId("brief"),
    version,
    parentVersion: version.nullable(),
    plannedAgentId: nodeId,
    assignmentId: generatedId("assignment"),
    plan: buildPlanRefSchema,
    source: architectureSourceRefSchema,
    mission: text(4_000),
    scope: scopeSchema,
    ownedNodeIds: unique(nodeId, (entry) => entry),
    relevantNodeIds: unique(nodeId, (entry) => entry),
    inputs: unique(
      contractPortSchema,
      (entry) => `${entry.contractId}\0${entry.nodeId}`,
    ),
    outputs: unique(
      contractPortSchema,
      (entry) => `${entry.contractId}\0${entry.nodeId}`,
    ),
    dependencies: unique(dependencySchema, (entry) => entry.dependencyId),
    deliverables: unique(deliverableSchema, (entry) => entry.deliverableId),
    acceptanceCriteria: unique(criterionSchema, (entry) => entry.criterionId),
    constraints: unique(constraintSchema, (entry) => entry.constraintId),
    milestones: unique(generatedId("milestone"), (entry) => entry),
    unresolvedDecisions: unique(decisionSchema, (entry) => entry.decisionId),
    changeProtocol: z
      .object({
        proposeArchitectureChanges: z.boolean(),
        instructions: unique(text(2_000), (entry) => entry),
      })
      .strict(),
    compilerVersion: opaqueId,
    dependencyFingerprints: unique(fingerprintSchema, (entry) => entry.kind),
    semanticDigest: digest,
    recordDigest: digest,
    authoredBy: actorSchema,
    createdAt: timestamp,
  })
  .strict()
  .superRefine((brief, context) => {
    if (brief.version === 1 && brief.parentVersion !== null)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentVersion"],
        message: "first version has no parent",
      });
    if (brief.version > 1 && brief.parentVersion !== brief.version - 1)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentVersion"],
        message: "parent must be previous version",
      });
    if (!brief.ownedNodeIds.includes(brief.plannedAgentId))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownedNodeIds"],
        message: "brief must own its planned agent",
      });
    if (hasDuplicateOrdinals(brief.acceptanceCriteria))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptanceCriteria"],
        message: "ordered records require unique ordinals",
      });
    const criterionIds = new Set(
      brief.acceptanceCriteria.map((entry) => entry.criterionId),
    );
    if (
      brief.deliverables.some((deliverable) =>
        deliverable.acceptanceCriterionIds.some((id) => !criterionIds.has(id)),
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliverables"],
        message: "unknown acceptance criterion",
      });
  });

export const planningAssignmentRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId,
    assignmentId: generatedId("assignment"),
    briefId: generatedId("brief"),
    plannedAgentId: nodeId,
    status: z.enum(["active", "retired"]),
    createdAt: timestamp,
    retiredAt: timestamp.nullable(),
    transitions: z
      .array(
        z
          .object({
            status: z.enum(["active", "retired"]),
            at: timestamp,
            planVersion: version,
          })
          .strict(),
      )
      .min(1)
      .max(1_024),
    recordDigest: digest,
  })
  .strict()
  .superRefine((assignment, context) => {
    if ((assignment.status === "retired") !== (assignment.retiredAt !== null))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retiredAt"],
        message: "assignment status mismatch",
      });
    if (
      assignment.transitions[0]?.status !== "active" ||
      assignment.transitions.at(-1)?.status !== assignment.status ||
      assignment.transitions.some(
        (entry, index) =>
          index > 0 &&
          entry.status === assignment.transitions[index - 1]?.status,
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions"],
        message: "invalid assignment lifecycle history",
      });
  });

export const builderPlanningSubmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    submissionId: generatedId("submission"),
    projectId,
    assignmentId: generatedId("assignment"),
    sessionId: opaqueId,
    source: architectureSourceRefSchema,
    plan: buildPlanRefSchema,
    brief: briefRefSchema,
    status: z.enum(["ready", "blocked", "changes-proposed"]),
    implementationPlan: unique(
      z
        .object({
          stepId: opaqueId,
          ordinal: version,
          description: text(2_000),
          verification: text(2_000),
        })
        .strict(),
      (entry) => entry.stepId,
    ),
    risks: unique(
      z
        .object({
          riskId: opaqueId,
          description: text(2_000),
          mitigation: text(2_000),
        })
        .strict(),
      (entry) => entry.riskId,
    ),
    questions: unique(
      z.object({ questionId: opaqueId, question: text(2_000) }).strict(),
      (entry) => entry.questionId,
    ),
    proposedMapOperationIds: unique(operationId, (entry) => entry),
    supersedesSubmissionId: generatedId("submission").nullable(),
    semanticDigest: digest,
    recordDigest: digest,
    submittedAt: timestamp,
  })
  .strict()
  .superRefine((submission, context) => {
    if (hasDuplicateOrdinals(submission.implementationPlan))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["implementationPlan"],
        message: "ordered records require unique ordinals",
      });
  });

const staleReasonSchema = z
  .object({
    code: z.enum([
      "source-changed",
      "agent-added",
      "agent-removed",
      "ownership-changed",
      "contract-changed",
      "relationship-changed",
      "relevant-node-changed",
      "shared-plan-content-changed",
      "assignment-content-changed",
    ]),
    affectedNodeIds: unique(nodeId, (entry) => entry),
    affectedRelationshipIds: unique(relationshipId, (entry) => entry),
    affectedContractIds: unique(opaqueId, (entry) => entry),
    previousFingerprint: digest.optional(),
    currentFingerprint: digest.optional(),
  })
  .strict();
const impactSchema = z
  .object({
    from: z
      .object({ source: architectureSourceRefSchema, plan: buildPlanRefSchema })
      .strict(),
    to: z
      .object({ source: architectureSourceRefSchema, plan: buildPlanRefSchema })
      .strict(),
    assignmentChanges: z
      .array(
        z
          .object({
            plannedAgentId: nodeId,
            assignmentId: generatedId("assignment").nullable(),
            briefId: generatedId("brief").nullable(),
            disposition: z.enum([
              "added",
              "removed",
              "stale",
              "preserved",
              "presentation-refreshed",
            ]),
            reasons: z.array(staleReasonSchema).max(9),
          })
          .strict(),
      )
      .max(256),
    staleBriefIds: unique(generatedId("brief"), (entry) => entry),
    preservedBriefIds: unique(generatedId("brief"), (entry) => entry),
    addedAgentIds: unique(nodeId, (entry) => entry),
    removedAgentIds: unique(nodeId, (entry) => entry),
    changedNodeIds: unique(nodeId, (entry) => entry),
    changedRelationshipIds: unique(relationshipId, (entry) => entry),
    changedContractIds: unique(opaqueId, (entry) => entry),
    semanticChange: z.boolean(),
    digest,
  })
  .strict();

const receiptSchema = z
  .object({
    sessionId: opaqueId,
    requestId: opaqueId,
    requestDigest: digest,
    resultRecordDigest: digest,
    result: z
      .object({
        operation: z.enum(["apply", "rebase"]),
        briefChanges: z
          .array(
            z
              .object({
                plannedAgentId: nodeId,
                change: z.enum(["created", "changed", "staled", "preserved"]),
              })
              .strict(),
          )
          .max(128),
        idMappings: z
          .array(
            z
              .object({
                kind: z.enum([
                  "milestone",
                  "criterion",
                  "deliverable",
                  "decision",
                ]),
                clientRef: opaqueId,
                id: opaqueId,
              })
              .strict(),
          )
          .max(BUILD_PLAN_ID_MAPPING_LIMIT),
        completeness: z
          .object({
            status: z.enum(["incomplete", "complete"]),
            issues: z
              .array(
                z
                  .object({
                    code: z.enum([
                      "missing-agent-assignment",
                      "unknown-node-reference",
                      "cross-project-reference",
                      "missing-brief",
                      "incompatible-contract-direction",
                      "ambiguous-contract-direction",
                      "ownership-cycle",
                      "multiple-top-level-owners",
                      "dangling-ownership",
                      "authored-architecture-conflict",
                      "brief-mission-missing",
                      "brief-scope-missing",
                      "brief-non-goals-suspicious",
                      "brief-deliverable-missing",
                      "brief-acceptance-criterion-missing",
                      "brief-change-protocol-missing",
                      "bootstrap-limit-exceeded",
                      "invalid-dependency",
                      "unresolved-required-decision",
                      "source-not-found",
                      "source-digest-mismatch",
                    ]),
                    severity: z.enum(["error", "warning"]),
                    path: z.string().max(512),
                    message: z.string().max(256),
                    relatedIds: z.array(opaqueId).max(16),
                  })
                  .strict(),
              )
              .max(64),
          })
          .strict(),
        eligibility: z
          .object({
            planningEligible: z.boolean(),
            implementationEligible: z.boolean(),
            reasons: z
              .array(
                z.enum([
                  "plan-incomplete",
                  "brief-missing",
                  "brief-stale",
                  "source-not-confirmed",
                ]),
              )
              .max(4),
          })
          .strict(),
        diagnostics: z
          .array(
            z
              .object({
                code: z.enum([
                  "missing-agent-assignment",
                  "unknown-node-reference",
                  "cross-project-reference",
                  "missing-brief",
                  "incompatible-contract-direction",
                  "ambiguous-contract-direction",
                  "ownership-cycle",
                  "multiple-top-level-owners",
                  "dangling-ownership",
                  "authored-architecture-conflict",
                  "brief-mission-missing",
                  "brief-scope-missing",
                  "brief-non-goals-suspicious",
                  "brief-deliverable-missing",
                  "brief-acceptance-criterion-missing",
                  "brief-change-protocol-missing",
                  "bootstrap-limit-exceeded",
                  "invalid-dependency",
                  "unresolved-required-decision",
                  "source-not-found",
                  "source-digest-mismatch",
                ]),
                severity: z.enum(["error", "warning"]),
                path: z.string().max(512),
                message: z.string().max(256),
                relatedIds: z.array(opaqueId).max(16),
              })
              .strict(),
          )
          .max(64),
        impact: impactSchema.optional(),
      })
      .strict()
      .optional(),
    createdAt: timestamp,
  })
  .strict();
const tombstoneSchema = z
  .object({ sessionId: opaqueId, requestId: opaqueId })
  .strict();

const buildPlanningAggregateSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: generatedId("build-plan").nullable(),
    currentPlanVersion: version.nullable(),
    planVersions: z
      .array(projectBuildPlanVersionSchema)
      .max(BUILD_PLAN_VERSION_HISTORY_LIMIT),
    currentBriefByAgentId: z.record(nodeId, briefRefSchema),
    briefVersionsById: z.record(
      generatedId("brief"),
      z
        .array(agentBriefVersionRecordSchema)
        .max(AGENT_BRIEF_VERSION_HISTORY_LIMIT),
    ),
    assignmentByAgentId: z.record(nodeId, planningAssignmentRecordSchema),
    submissionsByAssignmentId: z.record(
      generatedId("assignment"),
      z
        .array(builderPlanningSubmissionSchema)
        .max(PLANNING_SUBMISSION_HISTORY_LIMIT),
    ),
    idempotencyReceipts: z.array(receiptSchema).max(256),
    idempotencyTombstones: z
      .array(tombstoneSchema)
      .max(BUILD_PLAN_VERSION_HISTORY_LIMIT),
  })
  .strict();

export function parseArchitectureSourceRef(
  value: unknown,
): ArchitectureSourceRef {
  return architectureSourceRefSchema.parse(value) as ArchitectureSourceRef;
}

export function parseProjectBuildPlanVersion(
  value: unknown,
): ProjectBuildPlanVersion {
  return projectBuildPlanVersionSchema.parse(
    value,
  ) as unknown as ProjectBuildPlanVersion;
}

export function parseAgentBriefVersionRecord(
  value: unknown,
): AgentBriefVersionRecord {
  return agentBriefVersionRecordSchema.parse(
    value,
  ) as unknown as AgentBriefVersionRecord;
}

export function parsePlanningAssignmentRecord(
  value: unknown,
): PlanningAssignmentRecord {
  return planningAssignmentRecordSchema.parse(
    value,
  ) as unknown as PlanningAssignmentRecord;
}

export function parseBuilderPlanningSubmission(
  value: unknown,
): BuilderPlanningSubmission {
  return builderPlanningSubmissionSchema.parse(
    value,
  ) as unknown as BuilderPlanningSubmission;
}

/** Strict persistence parser. It rejects dangling/mismatched pointers and histories. */
export function parseBuildPlanningAggregate(
  value: unknown,
  expectedProjectId: string,
): BuildPlanningAggregateV1 {
  const aggregate = buildPlanningAggregateSchema.parse(
    value,
  ) as unknown as BuildPlanningAggregateV1;
  const fail = () => {
    throw new Error("invalid build planning aggregate");
  };
  if (
    (aggregate.planId === null) !== (aggregate.currentPlanVersion === null) ||
    (aggregate.planId === null) !== (aggregate.planVersions.length === 0)
  )
    fail();
  aggregate.planVersions.forEach((plan, index) => {
    if (
      plan.projectId !== expectedProjectId ||
      plan.planId !== aggregate.planId ||
      plan.version !== index + 1
    )
      fail();
  });
  if (
    aggregate.currentPlanVersion !== null &&
    !aggregate.planVersions.some(
      (plan) => plan.version === aggregate.currentPlanVersion,
    )
  )
    fail();
  if (
    aggregate.currentPlanVersion !== null &&
    aggregate.currentPlanVersion !== aggregate.planVersions.length
  )
    fail();

  const currentPlan = aggregate.planVersions.find(
    (plan) => plan.version === aggregate.currentPlanVersion,
  );

  const plans = new Map(
    aggregate.planVersions.map((plan) => [
      `${plan.planId}\0${plan.version}`,
      plan,
    ]),
  );
  const assignments = new Map<string, PlanningAssignmentRecord>();
  for (const [agentId, assignment] of Object.entries(
    aggregate.assignmentByAgentId,
  )) {
    if (
      assignment.projectId !== expectedProjectId ||
      assignment.plannedAgentId !== agentId ||
      assignments.has(assignment.assignmentId)
    )
      fail();
    if (
      assignment.transitions.some(
        (transition, index) =>
          transition.planVersion > (aggregate.currentPlanVersion ?? 0) ||
          (index > 0 &&
            transition.planVersion <=
              assignment.transitions[index - 1]!.planVersion),
      )
    )
      fail();
    assignments.set(assignment.assignmentId, assignment);
  }
  const activeAgentIds = Object.entries(aggregate.assignmentByAgentId)
    .filter(([, assignment]) => assignment.status === "active")
    .map(([agentId]) => agentId)
    .sort();
  const plannedAgentIds = (currentPlan?.assignments ?? [])
    .map((assignment) => assignment.plannedAgentId)
    .sort();
  if (JSON.stringify(activeAgentIds) !== JSON.stringify(plannedAgentIds))
    fail();
  const briefs = new Map<string, AgentBriefVersionRecord>();
  for (const [briefId, history] of Object.entries(
    aggregate.briefVersionsById,
  )) {
    history.forEach((brief, index) => {
      const plan = plans.get(`${brief.plan.planId}\0${brief.plan.version}`);
      const assignment = assignments.get(brief.assignmentId);
      if (
        brief.projectId !== expectedProjectId ||
        brief.briefId !== briefId ||
        brief.version !== index + 1 ||
        !plan ||
        plan.semanticDigest !== brief.plan.semanticDigest ||
        !architectureSourceRefsEqual(plan.source, brief.source) ||
        !assignment ||
        assignment.briefId !== brief.briefId ||
        assignment.plannedAgentId !== brief.plannedAgentId
      )
        fail();
      briefs.set(`${briefId}\0${brief.version}`, brief);
    });
  }
  for (const [agentId, ref] of Object.entries(
    aggregate.currentBriefByAgentId,
  )) {
    const brief = briefs.get(`${ref.briefId}\0${ref.version}`);
    const assignment = aggregate.assignmentByAgentId[agentId];
    if (
      !brief ||
      brief.semanticDigest !== ref.semanticDigest ||
      brief.plannedAgentId !== agentId ||
      !assignment ||
      assignment.status !== "active" ||
      ref.version !== aggregate.briefVersionsById[ref.briefId]?.length
    )
      fail();
  }
  const submissionIds = new Set<string>();
  for (const [assignmentId, history] of Object.entries(
    aggregate.submissionsByAssignmentId,
  )) {
    const assignment = assignments.get(assignmentId);
    if (!assignment) fail();
    history.forEach((submission, index) => {
      const plan = plans.get(
        `${submission.plan.planId}\0${submission.plan.version}`,
      );
      const brief = briefs.get(
        `${submission.brief.briefId}\0${submission.brief.version}`,
      );
      if (
        submissionIds.has(submission.submissionId) ||
        submission.projectId !== expectedProjectId ||
        submission.assignmentId !== assignmentId ||
        !plan ||
        plan.semanticDigest !== submission.plan.semanticDigest ||
        !architectureSourceRefsEqual(plan.source, submission.source) ||
        !brief ||
        brief.semanticDigest !== submission.brief.semanticDigest ||
        brief.assignmentId !== assignmentId ||
        (index === 0
          ? submission.supersedesSubmissionId !== null
          : submission.supersedesSubmissionId !==
            history[index - 1]?.submissionId)
      )
        fail();
      submissionIds.add(submission.submissionId);
    });
  }
  if (
    new Set(
      aggregate.idempotencyReceipts.map(
        (entry) => `${entry.sessionId}\0${entry.requestId}`,
      ),
    ).size !== aggregate.idempotencyReceipts.length
  )
    fail();
  const receiptKeys = new Set(
    aggregate.idempotencyReceipts.map(
      (entry) => `${entry.sessionId}\0${entry.requestId}`,
    ),
  );
  const tombstoneKeys = aggregate.idempotencyTombstones.map(
    (entry) => `${entry.sessionId}\0${entry.requestId}`,
  );
  if (
    new Set(tombstoneKeys).size !== tombstoneKeys.length ||
    tombstoneKeys.some((key) => receiptKeys.has(key)) ||
    aggregate.idempotencyReceipts.length + tombstoneKeys.length >
      aggregate.planVersions.length
  )
    fail();
  if (
    aggregate.idempotencyReceipts.some(
      (receipt) =>
        !aggregate.planVersions.some(
          (plan) => plan.recordDigest === receipt.resultRecordDigest,
        ),
    )
  )
    fail();
  return structuredClone(aggregate);
}
