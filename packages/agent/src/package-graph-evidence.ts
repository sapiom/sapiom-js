import { createHash } from "node:crypto";

import { z } from "zod/v4";

import {
  packageInventorySchema,
  packageInventoryVersionSchema,
  type PackageInventory,
  type PackageInventoryVersion,
} from "./package-inventory.js";

/** Protocol version for package-scoped, cross-agent graph evidence. */
export const PACKAGE_GRAPH_EVIDENCE_PROTOCOL = 1 as const;

export type PackageGraphEvidenceDigest = `sha256:${string}`;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const PRODUCER_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as const;

const digestSchema = z
  .string()
  .regex(SHA256, "Expected lowercase sha256:<64 hex characters>")
  .transform((value) => value as PackageGraphEvidenceDigest);
const opaqueReferenceValueSchema = z
  .string()
  .regex(OPAQUE_REFERENCE, "Expected a public-safe opaque reference");
const producerComponentSchema = z
  .string()
  .regex(PRODUCER_COMPONENT, "Expected a safe producer identifier");
const candidateEndpointSchema = z.string().max(512);

function referenceSchema<Kind extends string>(kind: Kind) {
  return z
    .object({
      kind: z.literal(kind),
      ref: opaqueReferenceValueSchema,
    })
    .strict();
}

const sourceCallsiteReferenceSchema = referenceSchema("source-callsite");
const dataflowPathReferenceSchema = referenceSchema("dataflow-path");
const runtimeCallsiteReferenceSchema = referenceSchema("runtime-callsite");
const executionReferenceSchema = referenceSchema("execution");
const lineageReferenceSchema = referenceSchema("lineage");

/**
 * Public-safe handle for evidence details retained behind an authorized
 * producer-owned resolver. Paths, execution IDs, lineage IDs, and payloads do
 * not enter the graph-evidence wire contract itself.
 */
export const packageGraphEvidenceReferenceSchema = z.discriminatedUnion(
  "kind",
  [
    sourceCallsiteReferenceSchema,
    dataflowPathReferenceSchema,
    runtimeCallsiteReferenceSchema,
    executionReferenceSchema,
    lineageReferenceSchema,
  ],
);
export type PackageGraphEvidenceReference = z.infer<
  typeof packageGraphEvidenceReferenceSchema
>;

export const packageGraphEvidenceProducerSchema = z
  .object({
    id: producerComponentSchema,
    version: producerComponentSchema,
  })
  .strict();
export type PackageGraphEvidenceProducer = z.infer<
  typeof packageGraphEvidenceProducerSchema
>;

const staticInvocationCandidateSchema = z
  .object({
    fromAgentKey: candidateEndpointSchema,
    toAgentKey: candidateEndpointSchema,
    relation: z.literal("invokes"),
    basis: z.literal("static-invocation"),
    mode: z.enum(["blocking", "async"]),
    callsites: z.array(sourceCallsiteReferenceSchema).min(1),
  })
  .strict();

const staticDataflowCandidateSchema = z
  .object({
    fromAgentKey: candidateEndpointSchema,
    toAgentKey: candidateEndpointSchema,
    relation: z.literal("feeds"),
    basis: z.literal("static-dataflow"),
    source: sourceCallsiteReferenceSchema,
    destination: sourceCallsiteReferenceSchema,
    path: z.array(dataflowPathReferenceSchema),
  })
  .strict();

const runtimeDispatchCandidateSchema = z
  .object({
    fromAgentKey: candidateEndpointSchema,
    toAgentKey: candidateEndpointSchema,
    relation: z.literal("invokes"),
    basis: z.literal("runtime-dispatch"),
    callerExecution: executionReferenceSchema,
    calleeExecution: executionReferenceSchema,
    callsite: runtimeCallsiteReferenceSchema.optional(),
  })
  .strict();

const runtimeHandoffCandidateSchema = z
  .object({
    fromAgentKey: candidateEndpointSchema,
    toAgentKey: candidateEndpointSchema,
    relation: z.literal("feeds"),
    basis: z.literal("runtime-handoff"),
    producerExecution: executionReferenceSchema,
    consumerExecution: executionReferenceSchema,
    lineage: lineageReferenceSchema,
    callsite: runtimeCallsiteReferenceSchema.optional(),
  })
  .strict();

/** The only four legal relation/basis combinations in protocol 1. */
export const packageGraphEvidenceCandidateSchema = z.discriminatedUnion(
  "basis",
  [
    staticInvocationCandidateSchema,
    staticDataflowCandidateSchema,
    runtimeDispatchCandidateSchema,
    runtimeHandoffCandidateSchema,
  ],
);
export type PackageGraphEvidenceCandidate = z.infer<
  typeof packageGraphEvidenceCandidateSchema
>;
export type PackageGraphStaticEvidenceCandidate = z.infer<
  typeof staticInvocationCandidateSchema | typeof staticDataflowCandidateSchema
>;
export type PackageGraphRuntimeEvidenceCandidate = z.infer<
  typeof runtimeDispatchCandidateSchema | typeof runtimeHandoffCandidateSchema
>;

const staticInvocationRecordSchema = staticInvocationCandidateSchema.extend({
  evidenceId: digestSchema,
});
const staticDataflowRecordSchema = staticDataflowCandidateSchema.extend({
  evidenceId: digestSchema,
});
const runtimeDispatchRecordSchema = runtimeDispatchCandidateSchema.extend({
  evidenceId: digestSchema,
});
const runtimeHandoffRecordSchema = runtimeHandoffCandidateSchema.extend({
  evidenceId: digestSchema,
});

export const packageGraphEvidenceRecordSchema = z.discriminatedUnion("basis", [
  staticInvocationRecordSchema,
  staticDataflowRecordSchema,
  runtimeDispatchRecordSchema,
  runtimeHandoffRecordSchema,
]);
export type PackageGraphEvidenceRecord = z.infer<
  typeof packageGraphEvidenceRecordSchema
>;
export type PackageGraphStaticEvidenceRecord = z.infer<
  typeof staticInvocationRecordSchema | typeof staticDataflowRecordSchema
>;
export type PackageGraphRuntimeEvidenceRecord = z.infer<
  typeof runtimeDispatchRecordSchema | typeof runtimeHandoffRecordSchema
>;

export const packageGraphEvidenceDiagnosticCodeSchema = z.enum([
  "invalid-candidate",
  "invalid-endpoint",
  "unknown-endpoint",
  "ambiguous-endpoint",
  "illegal-self-relationship",
  "cross-scope",
  "duplicate-evidence",
  "dynamic-target",
  "incomplete-analysis",
  "producer-failed",
  "runtime-event-conflict",
]);
export type PackageGraphEvidenceDiagnosticCode = z.infer<
  typeof packageGraphEvidenceDiagnosticCodeSchema
>;

export const packageGraphEvidenceDiagnosticSchema = z
  .object({
    code: packageGraphEvidenceDiagnosticCodeSchema,
    severity: z.enum(["warning", "error"]),
    candidateFingerprint: digestSchema.optional(),
    quarantineId: digestSchema.optional(),
    evidenceId: digestSchema.optional(),
    eventId: opaqueReferenceValueSchema.optional(),
    endpoint: z.enum(["from", "to"]).optional(),
    reference: packageGraphEvidenceReferenceSchema.optional(),
  })
  .strict();
export type PackageGraphEvidenceDiagnostic = z.infer<
  typeof packageGraphEvidenceDiagnosticSchema
>;

const quarantineCodeSchema = z.enum([
  "invalid-candidate",
  "invalid-endpoint",
  "unknown-endpoint",
  "ambiguous-endpoint",
  "illegal-self-relationship",
  "cross-scope",
]);

export const packageGraphEvidenceQuarantineSchema = z
  .object({
    quarantineId: digestSchema,
    candidateFingerprint: digestSchema,
    code: quarantineCodeSchema,
    endpoint: z.enum(["from", "to"]).optional(),
  })
  .strict();
export type PackageGraphEvidenceQuarantine = z.infer<
  typeof packageGraphEvidenceQuarantineSchema
>;

export const packageGraphEvidenceCoverageGapSchema = z
  .object({
    code: z.enum([
      "unreadable-source",
      "work-cap",
      "opaque-boundary",
      "dynamic-source",
      "producer-failed",
      "other",
    ]),
    reference: packageGraphEvidenceReferenceSchema.optional(),
  })
  .strict();
export type PackageGraphEvidenceCoverageGap = z.infer<
  typeof packageGraphEvidenceCoverageGapSchema
>;

export const packageGraphEvidenceCoverageSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("complete") }).strict(),
    z
      .object({
        status: z.literal("partial"),
        gaps: z.array(packageGraphEvidenceCoverageGapSchema).min(1),
      })
      .strict(),
    z
      .object({
        status: z.literal("none"),
        gaps: z.array(packageGraphEvidenceCoverageGapSchema).min(1),
      })
      .strict(),
  ],
);
export type PackageGraphEvidenceCoverage = z.infer<
  typeof packageGraphEvidenceCoverageSchema
>;

/** Canonical JSON for already-validated graph-evidence values. */
export function canonicalPackageGraphEvidenceJson(value: unknown): string {
  const seen = new Set<object>();

  const visit = (current: unknown): string => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new TypeError("Canonical JSON requires finite numbers");
      return JSON.stringify(current);
    }
    if (typeof current !== "object") {
      throw new TypeError("Canonical JSON accepts JSON values only");
    }
    if (seen.has(current))
      throw new TypeError("Canonical JSON rejects cyclic values");
    seen.add(current);
    try {
      if (Array.isArray(current)) return `[${current.map(visit).join(",")}]`;
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON accepts plain objects only");
      }
      const entries = Object.entries(current as Record<string, unknown>).sort(
        ([left], [right]) => compareText(left, right),
      );
      if (entries.some(([, child]) => child === undefined)) {
        throw new TypeError("Canonical JSON rejects undefined object fields");
      }
      return `{${entries
        .map(([key, child]) => `${JSON.stringify(key)}:${visit(child)}`)
        .join(",")}}`;
    } finally {
      seen.delete(current);
    }
  };

  return visit(value);
}

/** Full SHA-256 identity for canonical, already-validated semantic content. */
export function packageGraphEvidenceSha256(
  value: unknown,
): PackageGraphEvidenceDigest {
  return `sha256:${createHash("sha256").update(canonicalPackageGraphEvidenceJson(value)).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

const BASIS_ORDER: Record<PackageGraphEvidenceCandidate["basis"], number> = {
  "static-invocation": 0,
  "runtime-dispatch": 1,
  "static-dataflow": 2,
  "runtime-handoff": 3,
};

function compareReference(
  left: PackageGraphEvidenceReference,
  right: PackageGraphEvidenceReference,
): number {
  return compareText(left.kind, right.kind) || compareText(left.ref, right.ref);
}

function normalizeReferenceSet<T extends PackageGraphEvidenceReference>(
  references: readonly T[],
): T[] {
  return [
    ...new Map(
      [...references]
        .sort(compareReference)
        .map((reference) => [
          `${reference.kind}\u0000${reference.ref}`,
          reference,
        ]),
    ).values(),
  ];
}

function normalizeCandidate(
  candidate: PackageGraphEvidenceCandidate,
): PackageGraphEvidenceCandidate {
  switch (candidate.basis) {
    case "static-invocation":
      return {
        ...candidate,
        callsites: normalizeReferenceSet(candidate.callsites),
      };
    case "static-dataflow":
      return { ...candidate, path: [...candidate.path] };
    case "runtime-dispatch":
    case "runtime-handoff":
      return { ...candidate };
  }
}

function candidateFromRecord(
  record: PackageGraphEvidenceRecord,
): PackageGraphEvidenceCandidate {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "evidenceId"),
  ) as PackageGraphEvidenceCandidate;
}

function compareRecord(
  left: PackageGraphEvidenceRecord,
  right: PackageGraphEvidenceRecord,
): number {
  return (
    compareText(left.fromAgentKey, right.fromAgentKey) ||
    compareText(left.toAgentKey, right.toAgentKey) ||
    compareText(left.relation, right.relation) ||
    BASIS_ORDER[left.basis] - BASIS_ORDER[right.basis] ||
    compareText(left.evidenceId, right.evidenceId)
  );
}

function compareDiagnostic(
  left: PackageGraphEvidenceDiagnostic,
  right: PackageGraphEvidenceDiagnostic,
): number {
  return (
    compareText(left.code, right.code) ||
    compareText(left.severity, right.severity) ||
    compareText(
      left.candidateFingerprint ?? "",
      right.candidateFingerprint ?? "",
    ) ||
    compareText(left.quarantineId ?? "", right.quarantineId ?? "") ||
    compareText(left.evidenceId ?? "", right.evidenceId ?? "") ||
    compareText(left.eventId ?? "", right.eventId ?? "") ||
    compareText(left.endpoint ?? "", right.endpoint ?? "") ||
    compareText(left.reference?.kind ?? "", right.reference?.kind ?? "") ||
    compareText(left.reference?.ref ?? "", right.reference?.ref ?? "")
  );
}

function normalizeDiagnostics(
  diagnostics: readonly PackageGraphEvidenceDiagnostic[],
): PackageGraphEvidenceDiagnostic[] {
  return [
    ...new Map(
      [...diagnostics]
        .map((diagnostic) =>
          packageGraphEvidenceDiagnosticSchema.parse(diagnostic),
        )
        .sort(compareDiagnostic)
        .map((diagnostic) => [
          canonicalPackageGraphEvidenceJson(diagnostic),
          diagnostic,
        ]),
    ).values(),
  ];
}

function compareQuarantine(
  left: PackageGraphEvidenceQuarantine,
  right: PackageGraphEvidenceQuarantine,
): number {
  return (
    compareText(left.code, right.code) ||
    compareText(left.candidateFingerprint, right.candidateFingerprint) ||
    compareText(left.endpoint ?? "", right.endpoint ?? "") ||
    compareText(left.quarantineId, right.quarantineId)
  );
}

function normalizeQuarantine(
  quarantine: readonly PackageGraphEvidenceQuarantine[],
): PackageGraphEvidenceQuarantine[] {
  return [
    ...new Map(
      [...quarantine]
        .map((item) => packageGraphEvidenceQuarantineSchema.parse(item))
        .sort(compareQuarantine)
        .map((item) => [item.quarantineId, item]),
    ).values(),
  ];
}

function compareCoverageGap(
  left: PackageGraphEvidenceCoverageGap,
  right: PackageGraphEvidenceCoverageGap,
): number {
  return (
    compareText(left.code, right.code) ||
    compareText(left.reference?.kind ?? "", right.reference?.kind ?? "") ||
    compareText(left.reference?.ref ?? "", right.reference?.ref ?? "")
  );
}

function normalizeCoverage(
  coverage: PackageGraphEvidenceCoverage,
): PackageGraphEvidenceCoverage {
  if (coverage.status === "complete") return coverage;
  return {
    ...coverage,
    gaps: [
      ...new Map(
        [...coverage.gaps]
          .map((gap) => packageGraphEvidenceCoverageGapSchema.parse(gap))
          .sort(compareCoverageGap)
          .map((gap) => [canonicalPackageGraphEvidenceJson(gap), gap]),
      ).values(),
    ],
  };
}

function scopeMatches(
  left: PackageInventoryVersion,
  right: PackageInventoryVersion,
): boolean {
  return (
    canonicalPackageGraphEvidenceJson(left) ===
    canonicalPackageGraphEvidenceJson(right)
  );
}

function packageInventoryKeyIsValid(agentKey: string): boolean {
  const canonical = packageInventorySchema.safeParse({
    protocol: 1,
    version: {
      kind: "working-tree",
      workspaceKey: "graph-evidence-key-check",
      revision: ZERO_DIGEST,
    },
    status: "complete",
    agents: [
      {
        agentKey,
        identityStatus: "canonical",
        path: ".",
        entrypoint: "index.ts",
      },
    ],
  });
  if (canonical.success) return true;
  return packageInventorySchema.safeParse({
    protocol: 1,
    version: {
      kind: "working-tree",
      workspaceKey: "graph-evidence-key-check",
      revision: ZERO_DIGEST,
    },
    status: "degraded",
    agents: [
      {
        agentKey,
        identityStatus: "provisional",
        identityIssue: "identity-unavailable",
        path: ".",
        entrypoint: "index.ts",
      },
    ],
  }).success;
}

type QuarantineCode = z.infer<typeof quarantineCodeSchema>;

interface CandidateIdentityContext {
  protocol: typeof PACKAGE_GRAPH_EVIDENCE_PROTOCOL;
  scope: PackageInventoryVersion;
  producer: PackageGraphEvidenceProducer;
  analysisFingerprint?: PackageGraphEvidenceDigest;
  eventId?: string;
}

function quarantineCandidate(
  identity: CandidateIdentityContext,
  candidateFingerprint: PackageGraphEvidenceDigest,
  code: QuarantineCode,
  endpoint?: "from" | "to",
): {
  quarantine: PackageGraphEvidenceQuarantine;
  diagnostic: PackageGraphEvidenceDiagnostic;
} {
  const quarantineId = packageGraphEvidenceSha256({
    ...identity,
    candidateFingerprint,
    code,
    ...(endpoint === undefined ? {} : { endpoint }),
  });
  return {
    quarantine: {
      quarantineId,
      candidateFingerprint,
      code,
      ...(endpoint === undefined ? {} : { endpoint }),
    },
    diagnostic: {
      code,
      severity: "error",
      candidateFingerprint,
      quarantineId,
      ...(endpoint === undefined ? {} : { endpoint }),
    },
  };
}

interface CandidateValidationResult {
  records: PackageGraphEvidenceRecord[];
  diagnostics: PackageGraphEvidenceDiagnostic[];
  quarantine: PackageGraphEvidenceQuarantine[];
}

function validateCandidates(
  rawCandidates: readonly unknown[],
  inventory: PackageInventory,
  identity: CandidateIdentityContext,
  allowedBases: ReadonlySet<PackageGraphEvidenceCandidate["basis"]>,
): CandidateValidationResult {
  const records: PackageGraphEvidenceRecord[] = [];
  const diagnostics: PackageGraphEvidenceDiagnostic[] = [];
  const quarantine: PackageGraphEvidenceQuarantine[] = [];
  const inventoryKeys = new Set(
    inventory.agents.map((agent) => agent.agentKey),
  );
  const ambiguousCandidates = new Set(
    inventory.agents.flatMap((agent) =>
      agent.identityIssue === "duplicate-agent-key" && agent.candidateAgentKey
        ? [agent.candidateAgentKey]
        : [],
    ),
  );
  const seenEvidence = new Set<string>();
  const sameScope = scopeMatches(identity.scope, inventory.version);

  for (const rawCandidate of rawCandidates) {
    const parsed = packageGraphEvidenceCandidateSchema.safeParse(rawCandidate);
    if (!parsed.success || !allowedBases.has(parsed.data.basis)) {
      const candidateFingerprint = packageGraphEvidenceSha256({
        invalid: true,
        issues: parsed.success
          ? [{ code: "unsupported-basis", path: ["basis"] }]
          : parsed.error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
            })),
      });
      const rejected = quarantineCandidate(
        identity,
        candidateFingerprint,
        "invalid-candidate",
      );
      quarantine.push(rejected.quarantine);
      diagnostics.push(rejected.diagnostic);
      continue;
    }

    const candidate = normalizeCandidate(parsed.data);
    const candidateFingerprint = packageGraphEvidenceSha256(candidate);
    if (!sameScope) {
      const rejected = quarantineCandidate(
        identity,
        candidateFingerprint,
        "cross-scope",
      );
      quarantine.push(rejected.quarantine);
      diagnostics.push(rejected.diagnostic);
      continue;
    }

    let rejected = false;
    for (const [endpoint, agentKey] of [
      ["from", candidate.fromAgentKey],
      ["to", candidate.toAgentKey],
    ] as const) {
      if (inventoryKeys.has(agentKey)) continue;
      const code: QuarantineCode = ambiguousCandidates.has(agentKey)
        ? "ambiguous-endpoint"
        : packageInventoryKeyIsValid(agentKey)
          ? "unknown-endpoint"
          : "invalid-endpoint";
      const result = quarantineCandidate(
        identity,
        candidateFingerprint,
        code,
        endpoint,
      );
      quarantine.push(result.quarantine);
      diagnostics.push(result.diagnostic);
      rejected = true;
    }
    if (rejected) continue;
    if (candidate.fromAgentKey === candidate.toAgentKey) {
      const result = quarantineCandidate(
        identity,
        candidateFingerprint,
        "illegal-self-relationship",
      );
      quarantine.push(result.quarantine);
      diagnostics.push(result.diagnostic);
      continue;
    }

    const evidenceId = packageGraphEvidenceSha256({ ...identity, candidate });
    if (seenEvidence.has(evidenceId)) {
      diagnostics.push({
        code: "duplicate-evidence",
        severity: "warning",
        evidenceId,
      });
      continue;
    }
    seenEvidence.add(evidenceId);
    records.push({ ...candidate, evidenceId } as PackageGraphEvidenceRecord);
  }

  return {
    records: records.sort(compareRecord),
    diagnostics: normalizeDiagnostics(diagnostics),
    quarantine: normalizeQuarantine(quarantine),
  };
}

function expectedStaticEvidenceId(
  result: Pick<
    PackageGraphEvidenceStaticResult,
    "protocol" | "scope" | "producer" | "analysisFingerprint"
  >,
  record: PackageGraphStaticEvidenceRecord,
): PackageGraphEvidenceDigest {
  return packageGraphEvidenceSha256({
    protocol: result.protocol,
    scope: result.scope,
    producer: result.producer,
    analysisFingerprint: result.analysisFingerprint,
    candidate: candidateFromRecord(record),
  });
}

const staticResultBaseSchema = z
  .object({
    protocol: z.literal(PACKAGE_GRAPH_EVIDENCE_PROTOCOL),
    kind: z.literal("static-result"),
    resultId: digestSchema,
    scope: packageInventoryVersionSchema,
    producer: packageGraphEvidenceProducerSchema,
    analysisFingerprint: digestSchema,
    outcome: z.enum(["success", "failure"]),
    coverage: packageGraphEvidenceCoverageSchema,
    evidence: z.array(
      z.discriminatedUnion("basis", [
        staticInvocationRecordSchema,
        staticDataflowRecordSchema,
      ]),
    ),
    diagnostics: z.array(packageGraphEvidenceDiagnosticSchema),
    quarantine: z.array(packageGraphEvidenceQuarantineSchema),
  })
  .strict();

export type PackageGraphEvidenceStaticResult = z.infer<
  typeof staticResultBaseSchema
>;

function staticResultWithoutId(
  result: PackageGraphEvidenceStaticResult,
): Omit<PackageGraphEvidenceStaticResult, "resultId"> {
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "resultId"),
  ) as Omit<PackageGraphEvidenceStaticResult, "resultId">;
}

export const packageGraphEvidenceStaticResultSchema =
  staticResultBaseSchema.superRefine((result, context) => {
    if (result.outcome === "failure") {
      if (result.coverage.status !== "none") {
        context.addIssue({
          code: "custom",
          path: ["coverage"],
          message: "A failed static result requires no coverage",
        });
      }
      if (result.evidence.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "A failed static result cannot carry accepted evidence",
        });
      }
      if (
        !result.diagnostics.some(
          (diagnostic) => diagnostic.code === "producer-failed",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["diagnostics"],
          message:
            "A failed static result requires a producer-failed diagnostic",
        });
      }
    } else if (result.coverage.status === "none") {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message:
          "A successful static result requires complete or partial coverage",
      });
    }
    if (
      result.coverage.status === "partial" &&
      !result.diagnostics.some(
        (diagnostic) => diagnostic.code === "incomplete-analysis",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Partial coverage requires an incomplete-analysis diagnostic",
      });
    }
    if (
      result.coverage.status === "complete" &&
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "dynamic-target" ||
          diagnostic.code === "incomplete-analysis",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message:
          "Dynamic or incomplete analysis cannot claim complete coverage",
      });
    }

    const normalizedCoverage = normalizeCoverage(result.coverage);
    if (
      canonicalPackageGraphEvidenceJson(normalizedCoverage) !==
      canonicalPackageGraphEvidenceJson(result.coverage)
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Coverage gaps must be unique and canonically ordered",
      });
    }

    const normalizedEvidence = [...result.evidence].sort(compareRecord);
    if (
      new Set(normalizedEvidence.map((record) => record.evidenceId)).size !==
        normalizedEvidence.length ||
      canonicalPackageGraphEvidenceJson(normalizedEvidence) !==
        canonicalPackageGraphEvidenceJson(result.evidence)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Evidence must be unique and canonically ordered",
      });
    }
    for (const [index, record] of result.evidence.entries()) {
      if (record.evidenceId !== expectedStaticEvidenceId(result, record)) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "evidenceId"],
          message: "Evidence ID does not match semantic content",
        });
      }
    }

    if (
      canonicalPackageGraphEvidenceJson(
        normalizeDiagnostics(result.diagnostics),
      ) !== canonicalPackageGraphEvidenceJson(result.diagnostics)
    ) {
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Diagnostics must be unique and canonically ordered",
      });
    }
    if (
      canonicalPackageGraphEvidenceJson(
        normalizeQuarantine(result.quarantine),
      ) !== canonicalPackageGraphEvidenceJson(result.quarantine)
    ) {
      context.addIssue({
        code: "custom",
        path: ["quarantine"],
        message: "Quarantine entries must be unique and canonically ordered",
      });
    }
    for (const [index, item] of result.quarantine.entries()) {
      if (
        !result.diagnostics.some(
          (diagnostic) =>
            diagnostic.quarantineId === item.quarantineId &&
            diagnostic.code === item.code,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["quarantine", index],
          message: "Every quarantine entry requires a matching diagnostic",
        });
      }
    }
    if (
      result.resultId !==
      packageGraphEvidenceSha256(staticResultWithoutId(result))
    ) {
      context.addIssue({
        code: "custom",
        path: ["resultId"],
        message: "Result ID does not match canonical result content",
      });
    }
  });

export interface CreatePackageGraphEvidenceStaticResultInput {
  scope: PackageInventoryVersion;
  producer: PackageGraphEvidenceProducer;
  analysisFingerprint: PackageGraphEvidenceDigest;
  outcome: "success" | "failure";
  coverage: PackageGraphEvidenceCoverage;
  candidates: readonly unknown[];
  diagnostics?: readonly PackageGraphEvidenceDiagnostic[];
}

const createStaticResultInputSchema = z
  .object({
    scope: packageInventoryVersionSchema,
    producer: packageGraphEvidenceProducerSchema,
    analysisFingerprint: digestSchema,
    outcome: z.enum(["success", "failure"]),
    coverage: packageGraphEvidenceCoverageSchema,
    candidates: z.array(z.unknown()),
    diagnostics: z.array(packageGraphEvidenceDiagnosticSchema).optional(),
  })
  .strict();

/**
 * Validate candidates against one exact inventory, quarantine rejected
 * endpoints, normalize every set-like field, and derive canonical IDs.
 */
export function createPackageGraphEvidenceStaticResult(
  input: CreatePackageGraphEvidenceStaticResultInput,
  inventoryInput: PackageInventory,
): PackageGraphEvidenceStaticResult {
  const parsedInput = createStaticResultInputSchema.parse(input);
  const inventory = packageInventorySchema.parse(inventoryInput);
  if (
    parsedInput.outcome === "failure" &&
    parsedInput.candidates.length !== 0
  ) {
    throw new TypeError(
      "A failed static result cannot accept evidence candidates",
    );
  }
  const identity: CandidateIdentityContext = {
    protocol: PACKAGE_GRAPH_EVIDENCE_PROTOCOL,
    scope: parsedInput.scope,
    producer: parsedInput.producer,
    analysisFingerprint: parsedInput.analysisFingerprint,
  };
  const validated = validateCandidates(
    parsedInput.candidates,
    inventory,
    identity,
    new Set(["static-invocation", "static-dataflow"]),
  );
  const diagnostics = normalizeDiagnostics([
    ...(parsedInput.diagnostics ?? []),
    ...validated.diagnostics,
  ]);
  const draft: PackageGraphEvidenceStaticResult = {
    protocol: PACKAGE_GRAPH_EVIDENCE_PROTOCOL,
    kind: "static-result",
    resultId: ZERO_DIGEST,
    scope: parsedInput.scope,
    producer: parsedInput.producer,
    analysisFingerprint: parsedInput.analysisFingerprint,
    outcome: parsedInput.outcome,
    coverage: normalizeCoverage(parsedInput.coverage),
    evidence: validated.records as PackageGraphStaticEvidenceRecord[],
    diagnostics,
    quarantine: validated.quarantine,
  };
  const result = {
    ...draft,
    resultId: packageGraphEvidenceSha256(staticResultWithoutId(draft)),
  };
  return packageGraphEvidenceStaticResultSchema.parse(result);
}

const bundleScopeSchema = packageInventoryVersionSchema.refine(
  (scope): scope is Extract<PackageInventoryVersion, { kind: "bundle" }> =>
    scope.kind === "bundle",
  "Runtime evidence requires an immutable bundle scope",
);

const runtimeEventBaseSchema = z
  .object({
    protocol: z.literal(PACKAGE_GRAPH_EVIDENCE_PROTOCOL),
    kind: z.literal("runtime-event"),
    eventId: opaqueReferenceValueSchema,
    scope: bundleScopeSchema,
    producer: packageGraphEvidenceProducerSchema,
    evidence: z.discriminatedUnion("basis", [
      runtimeDispatchRecordSchema,
      runtimeHandoffRecordSchema,
    ]),
  })
  .strict();
export type PackageGraphRuntimeEvidenceEvent = z.infer<
  typeof runtimeEventBaseSchema
>;

function expectedRuntimeEvidenceId(
  event: Pick<
    PackageGraphRuntimeEvidenceEvent,
    "protocol" | "scope" | "producer" | "eventId"
  >,
  record: PackageGraphRuntimeEvidenceRecord,
): PackageGraphEvidenceDigest {
  return packageGraphEvidenceSha256({
    protocol: event.protocol,
    scope: event.scope,
    producer: event.producer,
    eventId: event.eventId,
    candidate: candidateFromRecord(record),
  });
}

export const packageGraphRuntimeEvidenceEventSchema =
  runtimeEventBaseSchema.superRefine((event, context) => {
    if (
      event.evidence.evidenceId !==
      expectedRuntimeEvidenceId(event, event.evidence)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "evidenceId"],
        message: "Evidence ID does not match the authoritative runtime event",
      });
    }
  });

export type CreatePackageGraphRuntimeEvidenceEventResult =
  | { status: "accepted"; event: PackageGraphRuntimeEvidenceEvent }
  | {
      status: "quarantined";
      diagnostics: readonly PackageGraphEvidenceDiagnostic[];
      quarantine: readonly PackageGraphEvidenceQuarantine[];
    };

const createRuntimeEventInputSchema = z
  .object({
    eventId: opaqueReferenceValueSchema,
    scope: bundleScopeSchema,
    producer: packageGraphEvidenceProducerSchema,
    candidate: z.unknown(),
  })
  .strict();

/** Build one idempotent runtime event, or a redacted quarantine result. */
export function createPackageGraphRuntimeEvidenceEvent(
  input: {
    eventId: string;
    scope: Extract<PackageInventoryVersion, { kind: "bundle" }>;
    producer: PackageGraphEvidenceProducer;
    candidate: unknown;
  },
  inventoryInput: PackageInventory,
): CreatePackageGraphRuntimeEvidenceEventResult {
  const parsedInput = createRuntimeEventInputSchema.parse(input);
  const inventory = packageInventorySchema.parse(inventoryInput);
  const identity: CandidateIdentityContext = {
    protocol: PACKAGE_GRAPH_EVIDENCE_PROTOCOL,
    scope: parsedInput.scope,
    producer: parsedInput.producer,
    eventId: parsedInput.eventId,
  };
  const validated = validateCandidates(
    [parsedInput.candidate],
    inventory,
    identity,
    new Set(["runtime-dispatch", "runtime-handoff"]),
  );
  if (validated.records.length !== 1 || validated.quarantine.length !== 0) {
    return {
      status: "quarantined",
      diagnostics: validated.diagnostics,
      quarantine: validated.quarantine,
    };
  }
  const event = {
    protocol: PACKAGE_GRAPH_EVIDENCE_PROTOCOL,
    kind: "runtime-event" as const,
    eventId: parsedInput.eventId,
    scope: parsedInput.scope,
    producer: parsedInput.producer,
    evidence: validated.records[0] as PackageGraphRuntimeEvidenceRecord,
  };
  return {
    status: "accepted",
    event: packageGraphRuntimeEvidenceEventSchema.parse(event),
  };
}

export type PackageGraphStaticEvidenceState =
  | {
      status: "ready" | "partial" | "stale";
      accepted: PackageGraphEvidenceStaticResult;
      latestAttempt: PackageGraphEvidenceStaticResult;
    }
  | {
      status: "failed";
      accepted?: never;
      latestAttempt: PackageGraphEvidenceStaticResult;
    };

function sameStaticProducerSlot(
  left: PackageGraphEvidenceStaticResult,
  right: PackageGraphEvidenceStaticResult,
): boolean {
  return (
    scopeMatches(left.scope, right.scope) &&
    left.producer.id === right.producer.id &&
    left.producer.version === right.producer.version
  );
}

function completeStaticResult(
  result: PackageGraphEvidenceStaticResult,
): boolean {
  return result.outcome === "success" && result.coverage.status === "complete";
}

/**
 * Reference replacement semantics only; SAP-2950 owns persistence. Complete
 * successes replace, while partial/failed attempts retain the accepted result.
 */
export function advancePackageGraphStaticEvidenceState(
  current: PackageGraphStaticEvidenceState | undefined,
  incomingInput: PackageGraphEvidenceStaticResult,
): PackageGraphStaticEvidenceState {
  const incoming = packageGraphEvidenceStaticResultSchema.parse(incomingInput);
  if (current && !sameStaticProducerSlot(current.latestAttempt, incoming)) {
    throw new TypeError(
      "Static evidence state cannot mix scopes or producer versions",
    );
  }
  if (completeStaticResult(incoming)) {
    return { status: "ready", accepted: incoming, latestAttempt: incoming };
  }
  if (incoming.outcome === "success") {
    if (current && current.status !== "failed") {
      return {
        status: "stale",
        accepted: current.accepted,
        latestAttempt: incoming,
      };
    }
    return { status: "partial", accepted: incoming, latestAttempt: incoming };
  }
  if (current && current.status !== "failed") {
    return {
      status: "stale",
      accepted: current.accepted,
      latestAttempt: incoming,
    };
  }
  return { status: "failed", latestAttempt: incoming };
}

export interface PackageGraphRuntimeEvidenceState {
  readonly events: readonly PackageGraphRuntimeEvidenceEvent[];
  readonly diagnostics: readonly PackageGraphEvidenceDiagnostic[];
}

export type AppendPackageGraphRuntimeEvidenceEventResult = {
  status: "accepted" | "duplicate" | "conflict";
  state: PackageGraphRuntimeEvidenceState;
};

/** Append by authoritative event ID; identical retries are no-ops, conflicts never replace. */
export function appendPackageGraphRuntimeEvidenceEvent(
  current: PackageGraphRuntimeEvidenceState,
  incomingInput: PackageGraphRuntimeEvidenceEvent,
): AppendPackageGraphRuntimeEvidenceEventResult {
  const incoming = packageGraphRuntimeEvidenceEventSchema.parse(incomingInput);
  const existing = current.events.find(
    (event) => event.eventId === incoming.eventId,
  );
  if (existing) {
    if (
      canonicalPackageGraphEvidenceJson(existing) ===
      canonicalPackageGraphEvidenceJson(incoming)
    ) {
      return { status: "duplicate", state: current };
    }
    const diagnostics = normalizeDiagnostics([
      ...current.diagnostics,
      {
        code: "runtime-event-conflict",
        severity: "error",
        eventId: incoming.eventId,
      },
    ]);
    return {
      status: "conflict",
      state: { events: current.events, diagnostics },
    };
  }
  return {
    status: "accepted",
    state: {
      events: [...current.events, incoming].sort((left, right) =>
        compareText(left.eventId, right.eventId),
      ),
      diagnostics: normalizeDiagnostics(current.diagnostics),
    },
  };
}

export interface PackageGraphEvidenceProjectedSupport {
  readonly evidenceId: PackageGraphEvidenceDigest;
  readonly basis: PackageGraphEvidenceCandidate["basis"];
  readonly mode?: "blocking" | "async";
}

export interface PackageGraphEvidenceConnector {
  readonly fromAgentKey: string;
  readonly toAgentKey: string;
  readonly relation: "invokes" | "feeds";
  readonly bases: readonly PackageGraphEvidenceCandidate["basis"][];
  readonly support: readonly PackageGraphEvidenceProjectedSupport[];
}

export interface PackageGraphEvidenceReferenceProjection {
  readonly scope: PackageInventoryVersion;
  readonly inventoryStatus: PackageInventory["status"];
  readonly nodes: readonly { readonly agentKey: string }[];
  readonly connectors: readonly PackageGraphEvidenceConnector[];
}

export type PackageGraphEvidenceProjectionSource =
  | PackageGraphEvidenceStaticResult
  | PackageGraphRuntimeEvidenceEvent;

/**
 * Small conformance projector: retain every inventory node, group accepted
 * evidence by explicit endpoints/relation, and preserve every supporting basis.
 */
export function projectPackageGraphEvidence(
  inventoryInput: PackageInventory,
  sourcesInput: readonly PackageGraphEvidenceProjectionSource[],
): PackageGraphEvidenceReferenceProjection {
  const inventory = packageInventorySchema.parse(inventoryInput);
  const inventoryKeys = new Set(
    inventory.agents.map((agent) => agent.agentKey),
  );
  const evidenceById = new Map<
    PackageGraphEvidenceDigest,
    PackageGraphEvidenceRecord
  >();
  for (const source of sourcesInput) {
    const parsed =
      source.kind === "static-result"
        ? packageGraphEvidenceStaticResultSchema.parse(source)
        : packageGraphRuntimeEvidenceEventSchema.parse(source);
    if (!scopeMatches(parsed.scope, inventory.version)) {
      throw new TypeError(
        "Reference projection cannot mix inventory and evidence scopes",
      );
    }
    const records =
      parsed.kind === "static-result" ? parsed.evidence : [parsed.evidence];
    for (const record of records) {
      const existing = evidenceById.get(record.evidenceId);
      if (
        existing &&
        canonicalPackageGraphEvidenceJson(existing) !==
          canonicalPackageGraphEvidenceJson(record)
      ) {
        throw new TypeError("One evidence ID cannot name different records");
      }
      evidenceById.set(record.evidenceId, record);
    }
  }

  const groups = new Map<string, PackageGraphEvidenceRecord[]>();
  for (const record of evidenceById.values()) {
    if (
      !inventoryKeys.has(record.fromAgentKey) ||
      !inventoryKeys.has(record.toAgentKey) ||
      record.fromAgentKey === record.toAgentKey
    ) {
      throw new TypeError(
        "Reference projection accepts validated evidence only",
      );
    }
    const key = `${record.fromAgentKey}\u0000${record.toAgentKey}\u0000${record.relation}`;
    const records = groups.get(key) ?? [];
    records.push(record);
    groups.set(key, records);
  }

  const connectors = [...groups.values()]
    .map((records): PackageGraphEvidenceConnector => {
      records.sort(compareRecord);
      const first = records[0]!;
      const support = records.map((record) => ({
        evidenceId: record.evidenceId,
        basis: record.basis,
        ...(record.basis === "static-invocation" ? { mode: record.mode } : {}),
      }));
      return {
        fromAgentKey: first.fromAgentKey,
        toAgentKey: first.toAgentKey,
        relation: first.relation,
        bases: [...new Set(records.map((record) => record.basis))].sort(
          (left, right) => BASIS_ORDER[left] - BASIS_ORDER[right],
        ),
        support,
      };
    })
    .sort(
      (left, right) =>
        compareText(left.fromAgentKey, right.fromAgentKey) ||
        compareText(left.toAgentKey, right.toAgentKey) ||
        compareText(left.relation, right.relation),
    );

  return {
    scope: inventory.version,
    inventoryStatus: inventory.status,
    nodes: inventory.agents.map(({ agentKey }) => ({ agentKey })),
    connectors,
  };
}
