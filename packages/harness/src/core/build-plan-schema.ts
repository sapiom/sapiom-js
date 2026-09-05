import { z } from "zod";
import { isCallerProjectRequestId } from "./project-request-namespace.js";

export const BUILD_PLAN_MAX_ITEMS = 128;
export const BUILD_PLAN_MAX_TEXT = 8_192;
export const BUILD_PLAN_MAX_MAPPINGS = 128;

const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const generatedId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${UUID_V7}$`, "u"));
const opaque = z.string().min(1).max(256).refine((value) => value.trim() === value &&
  !value.includes("/") && !value.includes("\\") &&
  ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f));
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const text = (maximum = BUILD_PLAN_MAX_TEXT, allowEmpty = false) => z.string().max(maximum)
  .refine((value) => allowEmpty ? value.trim() === value : value.trim().length > 0 && value.trim() === value);
const unique = <T extends z.ZodTypeAny>(schema: T, key: (value: z.infer<T>) => string) =>
  z.array(schema).max(BUILD_PLAN_MAX_ITEMS).superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const identity = key(value);
      if (seen.has(identity)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "duplicate identity" });
      seen.add(identity);
    });
  });
const strings = (maximum = 2_000) => unique(text(maximum), (value) => value);
const clientRef = z.object({ clientRef: opaque }).strict();
const idInput = (prefix: string) => z.union([generatedId(prefix), clientRef]);
const identityKey = (value: string | { clientRef: string }) =>
  typeof value === "string" ? value : `client:${value.clientRef}`;

export const toolMapVersionRefSchema = z.object({
  versionId: generatedId("mapv"),
  contentDigest: digest,
}).strict();
export const toolPlanVersionRefSchema = z.object({
  planId: generatedId("plan"),
  versionId: generatedId("planv"),
  semanticDigest: digest,
}).strict();

const focusedBriefSelectionSchema = z.object({
  focusScope: z.object({
    family: z.literal("ad-hoc-delegation"),
    delegationKey: opaque,
    parentScopeKey: digest.nullable(),
  }).strict(),
  nodeIds: unique(generatedId("node"), (value) => value).optional(),
  assignmentId: generatedId("work").optional(),
  mission: text(4_096).optional(),
  scope: strings(2_000).optional(),
  nonGoals: strings(2_000).optional(),
}).strict();

export const agentBriefRefreshRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: opaque.refine(isCallerProjectRequestId, "reserved request namespace"),
  expectedMap: toolMapVersionRefSchema,
  expectedPlan: toolPlanVersionRefSchema,
  focus: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("canonical") }).strict(),
    z.object({ mode: z.literal("focused"),
      selections: unique(focusedBriefSelectionSchema,
        (selection) => `${selection.focusScope.delegationKey}\0${selection.focusScope.parentScopeKey ?? ""}`),
    }).strict(),
  ]),
}).strict();

const milestone = z.object({
  id: idInput("milestone"),
  ordinal: z.number().int().safe().positive(),
  title: text(512),
  outcome: text(4_096),
  dependsOn: unique(idInput("milestone"), identityKey),
}).strict();
const sequenceGate = z.object({
  id: idInput("gate"),
  ordinal: z.number().int().safe().positive(),
  description: text(4_096),
  milestoneIds: unique(idInput("milestone"), identityKey),
}).strict();
const repositoryIntent = z.object({
  id: idInput("repository"),
  plannedAgentId: generatedId("node"),
  repository: text(512),
  packages: strings(512),
  ownershipBoundaries: strings(2_000),
}).strict();
const decision = z.object({
  id: idInput("decision"),
  question: text(4_096),
  resolution: text(4_096, true),
  status: z.enum(["open", "resolved"]),
}).strict();
const risk = z.object({
  id: idInput("risk"),
  description: text(4_096),
  mitigation: text(4_096, true),
}).strict();
const dependency = z.object({
  id: idInput("dependency"),
  kind: z.enum(["input", "output", "shared-resource", "depends-on"]),
  nodeId: generatedId("node"),
  relationshipIds: unique(generatedId("rel"), (value) => value),
  contractRef: text(256).nullable(),
}).strict();
const assignment = z.object({
  id: idInput("work"),
  plannedAgentId: generatedId("node"),
  briefId: idInput("brief").nullable(),
  mission: text(4_096),
  scope: strings(2_000),
  nonGoals: strings(2_000),
  dependencies: unique(dependency, (value) => identityKey(value.id)),
}).strict();

export const buildPlanContentInputSchema = z.object({
  outcome: text(BUILD_PLAN_MAX_TEXT, true),
  nonGoals: strings(2_000),
  milestones: unique(milestone, (value) => identityKey(value.id)),
  sequenceGates: unique(sequenceGate, (value) => identityKey(value.id)),
  sharedConstraints: strings(2_000),
  repositoryIntents: unique(repositoryIntent, (value) => identityKey(value.id)),
  integrationCriteria: strings(2_000),
  acceptanceCriteria: strings(2_000),
  decisions: unique(decision, (value) => identityKey(value.id)),
  assignments: unique(assignment, (value) => identityKey(value.id)),
  unresolvedDecisions: unique(decision, (value) => identityKey(value.id)),
  risks: unique(risk, (value) => identityKey(value.id)),
}).strict();

const replaceContentOperation = z.object({
  op: z.literal("replace-content"),
  content: buildPlanContentInputSchema,
}).strict();

export const buildPlanApplyRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: opaque.refine(isCallerProjectRequestId, "reserved request namespace"),
  expectedMap: toolMapVersionRefSchema,
  expectedPlan: toolPlanVersionRefSchema.nullable(),
  operations: z.tuple([replaceContentOperation]),
}).strict();

const rebaseResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remap-node"), fromNodeId: generatedId("node"), toNodeId: generatedId("node") }).strict(),
  z.object({ kind: z.literal("remove-assignment"), assignmentId: generatedId("work") }).strict(),
  z.object({ kind: z.literal("remove-repository-intent"), repositoryIntentId: generatedId("repository") }).strict(),
  z.object({ kind: z.literal("remove-dependency"), assignmentId: generatedId("work"), dependencyId: generatedId("dependency") }).strict(),
]);

export const buildPlanRebaseRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: opaque.refine(isCallerProjectRequestId, "reserved request namespace"),
  expectedPlan: toolPlanVersionRefSchema,
  fromMap: toolMapVersionRefSchema,
  toMap: toolMapVersionRefSchema,
  resolutions: unique(rebaseResolution, (resolution) => JSON.stringify(resolution)),
}).strict();

export const buildPlanReadRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({ kind: z.literal("exact"), planId: generatedId("plan"), versionId: generatedId("planv"), semanticDigest: digest }).strict(),
]);

/**
 * The MCP SDK accepts object schemas for tool discovery but currently renders a
 * top-level discriminated union as an empty object. Keep this strict transport
 * envelope separate from the exact domain union above; execution always parses
 * the request through `buildPlanReadRequestSchema` again.
 */
export const buildPlanReadToolInputSchema = z.object({
  kind: z.enum(["current", "exact"]),
  planId: generatedId("plan").optional(),
  versionId: generatedId("planv").optional(),
  semanticDigest: digest.optional(),
}).strict();

export type BuildPlanContentInput = z.infer<typeof buildPlanContentInputSchema>;
export type BuildPlanApplyRequest = z.infer<typeof buildPlanApplyRequestSchema>;
export type BuildPlanRebaseRequest = z.infer<typeof buildPlanRebaseRequestSchema>;
export type BuildPlanRebaseResolution = z.infer<typeof rebaseResolution>;
export type BuildPlanReadRequest = z.infer<typeof buildPlanReadRequestSchema>;
export type AgentBriefRefreshRequestInput = z.infer<typeof agentBriefRefreshRequestSchema>;

export const parseBuildPlanApplyRequest = (value: unknown): BuildPlanApplyRequest => buildPlanApplyRequestSchema.parse(value);
export const parseBuildPlanRebaseRequest = (value: unknown): BuildPlanRebaseRequest => buildPlanRebaseRequestSchema.parse(value);
export const parseBuildPlanReadRequest = (value: unknown): BuildPlanReadRequest => buildPlanReadRequestSchema.parse(value);
export const parseAgentBriefRefreshRequest = (value: unknown): AgentBriefRefreshRequestInput =>
  agentBriefRefreshRequestSchema.parse(value);
