import { z } from "zod/v4";

import type {
  PackageGraphEvidenceStaticResult,
  PackageInventory,
} from "@sapiom/agent";

export const FIXTURE_PROTOCOL = "semantic-graph-eval.fixture/1" as const;
export const ORACLE_PROTOCOL = "semantic-graph-eval.oracle/1" as const;
export const MOCK_PROVIDER_PROTOCOL =
  "semantic-graph-eval.mock-provider/1" as const;
export const MANIFEST_PROTOCOL = "semantic-graph-eval.manifest/1" as const;
export const PACKET_PROTOCOL = "semantic-graph-eval.packet/1" as const;
export const SNAPSHOT_PROTOCOL = "semantic-graph-eval.snapshot/1" as const;
export const REPORT_PROTOCOL = "semantic-graph-eval.report/1" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

export const digestSchema = z.string().regex(DIGEST);
export const safeIdSchema = z.string().regex(SAFE_ID);

export const fixtureRoleSchema = z.enum(["calibration", "holdout"]);
export type FixtureRole = z.infer<typeof fixtureRoleSchema>;

export const referencedFactSchema = z
  .object({
    ref: safeIdSchema,
    kind: z.enum([
      "responsibility",
      "input",
      "output",
      "capability",
      "shared-context",
    ]),
    text: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type ReferencedFact = z.infer<typeof referencedFactSchema>;

export const agentCardSchema = z
  .object({
    agentId: safeIdSchema,
    name: z.string().trim().min(1).max(120),
    facts: z.array(referencedFactSchema).min(1).max(32),
  })
  .strict();
export type AgentCard = z.infer<typeof agentCardSchema>;

export const coverageGapSchema = z
  .object({
    ref: safeIdSchema,
    code: z.enum([
      "opaque-store",
      "external-handoff",
      "dynamic-routing",
      "transformation",
      "truncated-context",
      "other",
    ]),
    agentIds: z.array(safeIdSchema).max(16),
    description: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type CoverageGap = z.infer<typeof coverageGapSchema>;

export const sourceExcerptSchema = z
  .object({
    ref: safeIdSchema,
    agentId: safeIdSchema,
    language: z.string().trim().min(1).max(40),
    path: z.string().trim().min(1).max(256),
    content: z.string().min(1).max(20_000),
  })
  .strict();
export type SourceExcerpt = z.infer<typeof sourceExcerptSchema>;

export const fixtureInputSchema = z
  .object({
    protocol: z.literal(FIXTURE_PROTOCOL),
    fixtureId: safeIdSchema,
    role: fixtureRoleSchema,
    categories: z
      .array(safeIdSchema)
      .min(1)
      .max(32)
      .refine((items) => new Set(items).size === items.length, {
        message: "Fixture categories must be unique",
      }),
    project: z
      .object({
        projectId: safeIdSchema,
        projectSnapshotDigest: digestSchema,
      })
      .strict(),
    inventory: z.unknown(),
    phaseAEvidence: z.unknown(),
    agentCards: z.array(agentCardSchema).min(1),
    sharedContext: z.array(referencedFactSchema).max(32),
    coverageGaps: z.array(coverageGapSchema).max(32),
    sourceExcerpts: z.array(sourceExcerptSchema).max(64),
  })
  .strict();
export type FixtureInput = z.infer<typeof fixtureInputSchema>;

export interface ValidatedFixtureInput extends Omit<
  FixtureInput,
  "inventory" | "phaseAEvidence"
> {
  inventory: PackageInventory;
  phaseAEvidence: PackageGraphEvidenceStaticResult;
}

export const feedPairSchema = z
  .object({
    sourceAgentId: safeIdSchema,
    targetAgentId: safeIdSchema,
  })
  .strict();
export type FeedPair = z.infer<typeof feedPairSchema>;

export const falsePositiveCategorySchema = z.enum([
  "shared-capability",
  "similar-schema",
  "sibling-invocations",
  "unrelated-agents",
  "unsupported-cycle",
  "invented-endpoint",
  "unexpected",
]);
export type FalsePositiveCategory = z.infer<typeof falsePositiveCategorySchema>;

export const fixtureOracleSchema = z
  .object({
    protocol: z.literal(ORACLE_PROTOCOL),
    fixtureId: safeIdSchema,
    expectedOutcome: z.enum(["proposals", "abstained"]),
    expectedFeeds: z.array(feedPairSchema),
    forbiddenFeeds: z.array(
      feedPairSchema.extend({ category: falsePositiveCategorySchema }),
    ),
  })
  .strict();
export type FixtureOracle = z.infer<typeof fixtureOracleSchema>;

export const experimentConfigurationSchema = z
  .object({
    id: z.enum([
      "facts-only.v1",
      "bounded-source.v1",
      "bounded-source.v2",
      "context-pressure.v1",
    ]),
    promptId: safeIdSchema,
    policyId: safeIdSchema,
    sourceSelectionId: safeIdSchema,
    outputSchemaId: safeIdSchema,
    maxSourceCharacters: z.number().int().nonnegative().max(100_000),
    maxPacketBytes: z.number().int().positive().max(1_000_000),
    maxOutputTokens: z.number().int().positive().max(16_000),
  })
  .strict();
export type ExperimentConfiguration = z.infer<
  typeof experimentConfigurationSchema
>;
export type ExperimentConfigurationId = ExperimentConfiguration["id"];

export const modelCandidateSchema = z
  .object({
    relationship: z.literal("feeds"),
    sourceAgentId: safeIdSchema,
    targetAgentId: safeIdSchema,
    explanation: z.string().trim().min(1).max(500),
    supportRefs: z.array(safeIdSchema).min(1).max(8),
  })
  .strict();
export type ModelCandidate = z.infer<typeof modelCandidateSchema>;

export const semanticModelEnvelopeSchema = z
  .object({
    outcome: z.enum(["complete", "partial", "abstained"]),
    candidates: z.array(z.unknown()).max(50),
  })
  .strict();
export type SemanticModelEnvelope = z.infer<typeof semanticModelEnvelopeSchema>;

export const SEMANTIC_MODEL_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { enum: ["complete", "partial", "abstained"] },
    candidates: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          relationship: { const: "feeds" },
          sourceAgentId: { type: "string", pattern: SAFE_ID.source },
          targetAgentId: { type: "string", pattern: SAFE_ID.source },
          explanation: { type: "string", minLength: 1, maxLength: 500 },
          supportRefs: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: { type: "string", pattern: SAFE_ID.source },
          },
        },
        required: [
          "relationship",
          "sourceAgentId",
          "targetAgentId",
          "explanation",
          "supportRefs",
        ],
      },
    },
  },
  required: ["outcome", "candidates"],
} as const;

export const providerUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    latencyMs: z.number().nonnegative(),
    servedClass: safeIdSchema.max(80).nullable(),
    lane: safeIdSchema.max(80).nullable(),
  })
  .strict();
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const mockProviderResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      rawResponse: z.unknown(),
      usage: providerUsageSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failure"),
      errorCode: safeIdSchema,
      latencyMs: z.number().nonnegative(),
    })
    .strict(),
]);
export type MockProviderResult = z.infer<typeof mockProviderResultSchema>;

export const mockProviderFixtureSchema = z
  .object({
    protocol: z.literal(MOCK_PROVIDER_PROTOCOL),
    fixtureId: safeIdSchema,
    responses: z.record(
      z.enum([
        "facts-only.v1",
        "bounded-source.v1",
        "bounded-source.v2",
        "context-pressure.v1",
      ]),
      mockProviderResultSchema,
    ),
  })
  .strict();
export type MockProviderFixture = z.infer<typeof mockProviderFixtureSchema>;

export const corpusManifestSchema = z
  .object({
    protocol: z.literal(MANIFEST_PROTOCOL),
    cases: z.array(
      z
        .object({
          fixtureId: safeIdSchema,
          role: fixtureRoleSchema,
          categories: z.array(safeIdSchema).min(1),
          inputFingerprint: digestSchema,
          oracleFingerprint: digestSchema,
          providerResponseFingerprint: digestSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type CorpusManifest = z.infer<typeof corpusManifestSchema>;

export interface LoadedFixture {
  input: ValidatedFixtureInput;
  oracle: FixtureOracle;
  providerFixture: MockProviderFixture;
  inputFingerprint: string;
  oracleFingerprint: string;
  providerResponseFingerprint: string;
}

export interface ReferencedPacketItem {
  ref: string;
  kind: string;
  text: string;
}

export interface SemanticGraphPacket {
  protocol: typeof PACKET_PROTOCOL;
  fixtureId: string;
  project: FixtureInput["project"];
  inventory: Pick<PackageInventory, "protocol" | "version" | "status">;
  configuration: {
    id: ExperimentConfigurationId;
    promptId: string;
    policyId: string;
    sourceSelectionId: string;
    outputSchemaId: string;
  };
  agents: Array<{
    agentId: string;
    name: string;
    facts: ReferencedPacketItem[];
  }>;
  provenRelationships: Array<{
    ref: string;
    relationship: "invokes" | "feeds";
    sourceAgentId: string;
    targetAgentId: string;
    basis: string;
  }>;
  sharedContext: ReferencedPacketItem[];
  coverageGaps: Array<{
    ref: string;
    code: string;
    agentIds: string[];
    description: string;
  }>;
  sourceExcerpts: Array<{
    ref: string;
    agentId: string;
    language: string;
    content: string;
    truncated: boolean;
  }>;
  contextPressure: {
    sourceCharactersAvailable: number;
    sourceCharactersIncluded: number;
    omittedExcerptCount: number;
    truncatedExcerptCount: number;
    serializedBytes: number;
    estimatedTokens: number;
    maxPacketBytes: number;
    sectionBytes: {
      project: number;
      inventory: number;
      configuration: number;
      agents: number;
      provenRelationships: number;
      sharedContext: number;
      coverageGaps: number;
      sourceExcerpts: number;
    };
  };
}

export interface SemanticPrompt {
  system: string;
  user: string;
  outputName: "propose_semantic_feeds";
  outputSchema: typeof SEMANTIC_MODEL_OUTPUT_JSON_SCHEMA;
}

export interface ProviderRequest {
  fixtureId: string;
  requestedModel: "gpt-luna";
  configuration: ExperimentConfiguration;
  configurationFingerprint: string;
  inputFingerprint: string;
  packetFingerprint: string;
  promptFingerprint: string;
  packet: SemanticGraphPacket;
  prompt: SemanticPrompt;
}

export type ProviderAttempt =
  | {
      status: "success";
      rawResponse: unknown;
      usage: ProviderUsage;
      requestedModel: string;
    }
  | {
      status: "failure";
      errorCode: string;
      latencyMs: number;
      requestedModel: string;
    }
  | {
      status: "harness-failure";
      errorCode: string;
      latencyMs: number;
      requestedModel: string;
    };

export type RejectionCode =
  | "malformed-output"
  | "harness-failure"
  | "invalid-candidate"
  | "abstained-with-candidates"
  | "unknown-endpoint"
  | "self-link"
  | "fabricated-support-ref"
  | "duplicate-candidate"
  | "already-proven";

export interface RejectedCandidate {
  index: number | null;
  code: RejectionCode;
  candidateFingerprint: string;
}

export interface AcceptedSemanticCandidate extends ModelCandidate {
  candidateId: string;
  supportRefs: string[];
}

export interface AcceptedSemanticSnapshot {
  protocol: typeof SNAPSHOT_PROTOCOL;
  fixtureId: string;
  configurationId: ExperimentConfigurationId;
  inputFingerprint: string;
  configurationFingerprint: string;
  attemptStatus: "accepted" | "provider-failure" | "malformed";
  providerErrorCode: string | null;
  outcome: "complete" | "partial" | "abstained" | "failed";
  accepted: AcceptedSemanticCandidate[];
  rejected: RejectedCandidate[];
}

export interface EvaluationMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  correctAbstention: boolean;
  abstention: "correct" | "incorrect" | "not-applicable";
  falsePositiveCategories: Partial<Record<FalsePositiveCategory, number>>;
}

export interface EvaluationRunReport {
  protocol: typeof REPORT_PROTOCOL;
  fixtureId: string;
  role: FixtureRole;
  categories: string[];
  configurationId: ExperimentConfigurationId;
  inputFingerprint: string;
  configurationFingerprint: string;
  packetFingerprint: string;
  promptFingerprint: string;
  outputFingerprint: string;
  requestedModel: string;
  providerLatencyMs: number;
  snapshot: AcceptedSemanticSnapshot;
  metrics: EvaluationMetrics;
  usage: ProviderUsage | null;
  contextPressure: SemanticGraphPacket["contextPressure"];
}

export interface EvaluationAggregateMetrics {
  runs: number;
  providerFailures: number;
  malformedAttempts: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  correctAbstentions: number;
  incorrectAbstentions: number;
  rejectionCodes: Partial<Record<RejectionCode, number>>;
  falsePositiveCategories: Partial<Record<FalsePositiveCategory, number>>;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
}

export interface EvaluationAggregateReport {
  protocol: typeof REPORT_PROTOCOL;
  corpusProtocol: typeof MANIFEST_PROTOCOL;
  provider: "mock" | "sapiom-luna";
  requestedModel: "gpt-luna";
  fixtureSet: "calibration" | "holdout" | "all";
  configurationIds: ExperimentConfigurationId[];
  corpusFingerprint: string;
  runFingerprints: string[];
  metrics: EvaluationAggregateMetrics;
  metricsByRole: Partial<Record<FixtureRole, EvaluationAggregateMetrics>>;
  metricsByConfiguration: Partial<
    Record<ExperimentConfigurationId, EvaluationAggregateMetrics>
  >;
  runs: EvaluationRunReport[];
}
