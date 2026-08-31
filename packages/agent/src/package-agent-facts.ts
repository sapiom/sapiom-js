import { createHash } from "node:crypto";

import { z } from "zod/v4";

import {
  packageInventorySchema,
  packageInventoryVersionSchema,
  type PackageInventory,
  type PackageInventoryVersion,
} from "./package-inventory.js";

/** Protocol version for package-scoped, per-agent factual metadata. */
export const PACKAGE_AGENT_FACTS_PROTOCOL = 1 as const;

export type PackageAgentFactsDigest = `sha256:${string}`;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const PRODUCER_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as const;

const digestSchema = z
  .string()
  .regex(SHA256, "Expected lowercase sha256:<64 hex characters>")
  .transform((value) => value as PackageAgentFactsDigest);
const opaqueReferenceValueSchema = z
  .string()
  .regex(OPAQUE_REFERENCE, "Expected a public-safe opaque reference");
const producerComponentSchema = z
  .string()
  .regex(PRODUCER_COMPONENT, "Expected a safe producer identifier");

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.boolean(),
    z.number().finite(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

function referenceSchema<Kind extends string>(kind: Kind) {
  return z
    .object({
      kind: z.literal(kind),
      ref: opaqueReferenceValueSchema,
    })
    .strict();
}

export const packageAgentFactsSourceReferenceSchema = z.discriminatedUnion(
  "kind",
  [referenceSchema("source-card"), referenceSchema("manifest")],
);
export type PackageAgentFactsSourceReference = z.infer<
  typeof packageAgentFactsSourceReferenceSchema
>;

export const packageAgentFactsDirectReferenceSchema = z.discriminatedUnion(
  "kind",
  [referenceSchema("agent-card"), referenceSchema("manifest-field")],
);
export type PackageAgentFactsDirectReference = z.infer<
  typeof packageAgentFactsDirectReferenceSchema
>;

export const packageAgentFactsEvidenceReferenceSchema = z.discriminatedUnion(
  "kind",
  [
    referenceSchema("agent-facts-evidence"),
    referenceSchema("graph-evidence-result"),
    referenceSchema("graph-evidence-record"),
  ],
);
export type PackageAgentFactsEvidenceReference = z.infer<
  typeof packageAgentFactsEvidenceReferenceSchema
>;

export const packageAgentFactsProducerSchema = z
  .object({
    id: producerComponentSchema,
    version: producerComponentSchema,
  })
  .strict();
export type PackageAgentFactsProducer = z.infer<
  typeof packageAgentFactsProducerSchema
>;

const capabilitySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      }),
    "Capability names must not contain control characters",
  );

const stringOrNullFieldSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("known"), value: z.string().nullable() })
    .strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
const schemaFieldSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("known"), value: jsonObjectSchema.nullable() })
    .strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
const capabilityFieldSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("known"), values: z.array(capabilitySchema) })
    .strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);

export type PackageAgentFactsStringField = z.infer<
  typeof stringOrNullFieldSchema
>;
export type PackageAgentFactsSchemaField = z.infer<typeof schemaFieldSchema>;
export type PackageAgentFactsCapabilityField = z.infer<
  typeof capabilityFieldSchema
>;

export const packageAgentFactsDiagnosticCodeSchema = z.enum([
  "missing-card",
  "invalid-card",
  "duplicate-card",
  "unknown-agent-key",
  "invalid-observation",
  "unsupported-observed-fact",
  "incomplete-extraction",
  "dynamic-data",
]);
export type PackageAgentFactsDiagnosticCode = z.infer<
  typeof packageAgentFactsDiagnosticCodeSchema
>;

export const packageAgentFactsDiagnosticSchema = z
  .object({
    code: packageAgentFactsDiagnosticCodeSchema,
    severity: z.enum(["warning", "error"]),
    agentKey: z.string().optional(),
    reference: z
      .union([
        packageAgentFactsSourceReferenceSchema,
        packageAgentFactsDirectReferenceSchema,
        packageAgentFactsEvidenceReferenceSchema,
      ])
      .optional(),
  })
  .strict();
export type PackageAgentFactsDiagnostic = z.infer<
  typeof packageAgentFactsDiagnosticSchema
>;

export const packageAgentFactsCompletenessSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("complete") }).strict(),
    z
      .object({
        status: z.literal("partial"),
        diagnostics: z.array(packageAgentFactsDiagnosticSchema).min(1),
      })
      .strict(),
    z
      .object({
        status: z.literal("unknown"),
        diagnostics: z.array(packageAgentFactsDiagnosticSchema).min(1),
      })
      .strict(),
  ],
);
export type PackageAgentFactsCompleteness = z.infer<
  typeof packageAgentFactsCompletenessSchema
>;

const observedCapabilityObservationSchema = z
  .object({
    kind: z.literal("capability-call"),
    capability: capabilitySchema,
    reference: packageAgentFactsEvidenceReferenceSchema.optional(),
  })
  .strict();

const cardInputSchema = z
  .object({
    agentKey: z.string(),
    sourceReferences: z
      .array(packageAgentFactsSourceReferenceSchema)
      .optional(),
    directReferences: z
      .array(packageAgentFactsDirectReferenceSchema)
      .optional(),
    evidenceReferences: z
      .array(packageAgentFactsEvidenceReferenceSchema)
      .optional(),
    description: z.string().nullable().optional(),
    inputSchema: jsonObjectSchema.nullable().optional(),
    outputSchema: jsonObjectSchema.nullable().optional(),
    declaredCapabilities: z.array(capabilitySchema).optional(),
    observed: z.array(z.unknown()).optional(),
    completeness: packageAgentFactsCompletenessSchema.optional(),
  })
  .strict();

export type PackageAgentFactsCardInput = z.infer<typeof cardInputSchema>;

export const packageAgentFactsRecordSchema = z
  .object({
    agentKey: z.string(),
    description: stringOrNullFieldSchema,
    inputSchema: schemaFieldSchema,
    outputSchema: schemaFieldSchema,
    capabilities: z
      .object({
        declared: capabilityFieldSchema,
        observed: capabilityFieldSchema,
      })
      .strict(),
    references: z
      .object({
        source: z.array(packageAgentFactsSourceReferenceSchema),
        direct: z.array(packageAgentFactsDirectReferenceSchema),
        evidence: z.array(packageAgentFactsEvidenceReferenceSchema),
      })
      .strict(),
    completeness: packageAgentFactsCompletenessSchema,
    summary: z.string(),
  })
  .strict()
  .superRefine((record, context) => {
    for (const [field, capabilities] of [
      ["declared", record.capabilities.declared],
      ["observed", record.capabilities.observed],
    ] as const) {
      if (
        capabilities.status === "known" &&
        canonicalPackageAgentFactsJson(capabilities.values) !==
          canonicalPackageAgentFactsJson(
            normalizeCapabilities(capabilities.values),
          )
      ) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", field, "values"],
          message: "Capabilities must be unique and canonically ordered",
        });
      }
    }
    const expectedSummary = summarizeAgentFacts(record.agentKey, {
      description: record.description,
      inputSchema: record.inputSchema,
      outputSchema: record.outputSchema,
      declared: record.capabilities.declared,
      observed: record.capabilities.observed,
    });
    if (record.summary !== expectedSummary) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "Summary does not match deterministic template content",
      });
    }
  });
export type PackageAgentFactsRecord = z.infer<
  typeof packageAgentFactsRecordSchema
>;

const snapshotBaseSchema = z
  .object({
    protocol: z.literal(PACKAGE_AGENT_FACTS_PROTOCOL),
    kind: z.literal("agent-facts-snapshot"),
    snapshotId: digestSchema,
    scope: packageInventoryVersionSchema,
    extractor: packageAgentFactsProducerSchema,
    inventoryStatus: z.enum(["complete", "degraded"]),
    agents: z.array(packageAgentFactsRecordSchema),
    diagnostics: z.array(packageAgentFactsDiagnosticSchema),
  })
  .strict();

export type PackageAgentFactsSnapshot = z.infer<typeof snapshotBaseSchema>;

export interface CreatePackageAgentFactsSnapshotInput {
  scope: PackageInventoryVersion;
  extractor: PackageAgentFactsProducer;
  cards: readonly unknown[];
  diagnostics?: readonly PackageAgentFactsDiagnostic[];
}

const createSnapshotInputSchema = z
  .object({
    scope: packageInventoryVersionSchema,
    extractor: packageAgentFactsProducerSchema,
    cards: z.array(z.unknown()),
    diagnostics: z.array(packageAgentFactsDiagnosticSchema).optional(),
  })
  .strict();

/** Canonical JSON for already-validated AgentFacts values. */
export function canonicalPackageAgentFactsJson(value: unknown): string {
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

function packageAgentFactsSha256(value: unknown): PackageAgentFactsDigest {
  return `sha256:${createHash("sha256").update(canonicalPackageAgentFactsJson(value)).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function scopeMatches(
  left: PackageInventoryVersion,
  right: PackageInventoryVersion,
): boolean {
  return (
    canonicalPackageAgentFactsJson(left) ===
    canonicalPackageAgentFactsJson(right)
  );
}

function canonicalizeJsonObject<T>(value: T): T {
  return JSON.parse(canonicalPackageAgentFactsJson(value)) as T;
}

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities)].sort(compareText);
}

function normalizeByCanonical<T>(
  values: readonly T[],
  parse: (value: T) => T,
): T[] {
  return [
    ...new Map(
      values
        .map(parse)
        .sort((left, right) =>
          compareText(
            canonicalPackageAgentFactsJson(left),
            canonicalPackageAgentFactsJson(right),
          ),
        )
        .map((value) => [canonicalPackageAgentFactsJson(value), value]),
    ).values(),
  ];
}

function compareDiagnostic(
  left: PackageAgentFactsDiagnostic,
  right: PackageAgentFactsDiagnostic,
): number {
  return (
    compareText(left.agentKey ?? "", right.agentKey ?? "") ||
    compareText(left.code, right.code) ||
    compareText(left.severity, right.severity) ||
    compareText(left.reference?.kind ?? "", right.reference?.kind ?? "") ||
    compareText(left.reference?.ref ?? "", right.reference?.ref ?? "")
  );
}

function normalizeDiagnostics(
  diagnostics: readonly PackageAgentFactsDiagnostic[],
): PackageAgentFactsDiagnostic[] {
  return [
    ...new Map(
      diagnostics
        .map((diagnostic) =>
          packageAgentFactsDiagnosticSchema.parse(diagnostic),
        )
        .sort(compareDiagnostic)
        .map((diagnostic) => [
          canonicalPackageAgentFactsJson(diagnostic),
          diagnostic,
        ]),
    ).values(),
  ];
}

function normalizeCompleteness(
  completeness: PackageAgentFactsCompleteness,
): PackageAgentFactsCompleteness {
  if (completeness.status === "complete") return completeness;
  return {
    ...completeness,
    diagnostics: normalizeDiagnostics(completeness.diagnostics),
  };
}

function unknownRecord(
  agentKey: string,
  diagnostics: readonly PackageAgentFactsDiagnostic[],
): PackageAgentFactsRecord {
  const completeness = normalizeCompleteness({
    status: "unknown",
    diagnostics: [...diagnostics],
  });
  return {
    agentKey,
    description: { status: "unknown" },
    inputSchema: { status: "unknown" },
    outputSchema: { status: "unknown" },
    capabilities: {
      declared: { status: "unknown" },
      observed: { status: "unknown" },
    },
    references: { source: [], direct: [], evidence: [] },
    completeness,
    summary: summarizeAgentFacts(agentKey, {
      description: { status: "unknown" },
      inputSchema: { status: "unknown" },
      outputSchema: { status: "unknown" },
      declared: { status: "unknown" },
      observed: { status: "unknown" },
    }),
  };
}

function summarizeAgentFacts(
  agentKey: string,
  fields: {
    description: PackageAgentFactsStringField;
    inputSchema: PackageAgentFactsSchemaField;
    outputSchema: PackageAgentFactsSchemaField;
    declared: PackageAgentFactsCapabilityField;
    observed: PackageAgentFactsCapabilityField;
  },
): string {
  const description =
    fields.description.status === "known"
      ? fields.description.value === null
        ? "none"
        : fields.description.value
      : "unknown";
  const input = fields.inputSchema.status === "known" ? "known" : "unknown";
  const output = fields.outputSchema.status === "known" ? "known" : "unknown";
  const declared =
    fields.declared.status === "known"
      ? fields.declared.values.length === 0
        ? "none"
        : fields.declared.values.join(", ")
      : "unknown";
  const observed =
    fields.observed.status === "known"
      ? fields.observed.values.length === 0
        ? "none"
        : fields.observed.values.join(", ")
      : "unknown";
  return `agentKey: ${agentKey}; authored description: ${description}; input schema: ${input}; output schema: ${output}; declared capabilities: ${declared}; observed capabilities: ${observed}`;
}

function recordFromCard(
  agentKey: string,
  card: PackageAgentFactsCardInput,
): {
  record: PackageAgentFactsRecord;
  diagnostics: PackageAgentFactsDiagnostic[];
} {
  const diagnostics: PackageAgentFactsDiagnostic[] = [];
  const observedCapabilities: string[] = [];
  const evidenceReferences: PackageAgentFactsEvidenceReference[] = [
    ...(card.evidenceReferences ?? []),
  ];

  for (const observed of card.observed ?? []) {
    const parsed = observedCapabilityObservationSchema.safeParse(observed);
    if (!parsed.success) {
      const rawKind =
        typeof observed === "object" &&
        observed !== null &&
        "kind" in observed &&
        typeof observed.kind === "string"
          ? observed.kind
          : undefined;
      diagnostics.push({
        code:
          rawKind === undefined || rawKind === "capability-call"
            ? "invalid-observation"
            : "unsupported-observed-fact",
        severity: "warning",
        agentKey,
      });
      continue;
    }
    observedCapabilities.push(parsed.data.capability);
    if (parsed.data.reference) evidenceReferences.push(parsed.data.reference);
  }

  const description: PackageAgentFactsStringField =
    "description" in card
      ? { status: "known", value: card.description ?? null }
      : { status: "unknown" };
  const inputSchema: PackageAgentFactsSchemaField =
    "inputSchema" in card
      ? {
          status: "known",
          value: canonicalizeJsonObject(card.inputSchema ?? null),
        }
      : { status: "unknown" };
  const outputSchema: PackageAgentFactsSchemaField =
    "outputSchema" in card
      ? {
          status: "known",
          value: canonicalizeJsonObject(card.outputSchema ?? null),
        }
      : { status: "unknown" };
  const declared: PackageAgentFactsCapabilityField =
    card.declaredCapabilities !== undefined
      ? {
          status: "known",
          values: normalizeCapabilities(card.declaredCapabilities),
        }
      : { status: "unknown" };
  const observed: PackageAgentFactsCapabilityField =
    card.observed !== undefined
      ? { status: "known", values: normalizeCapabilities(observedCapabilities) }
      : { status: "unknown" };
  const completeness = normalizeCompleteness(
    card.completeness ?? { status: "complete" },
  );
  const record = {
    agentKey,
    description,
    inputSchema,
    outputSchema,
    capabilities: { declared, observed },
    references: {
      source: normalizeByCanonical(
        card.sourceReferences ?? [],
        packageAgentFactsSourceReferenceSchema.parse,
      ),
      direct: normalizeByCanonical(
        card.directReferences ?? [],
        packageAgentFactsDirectReferenceSchema.parse,
      ),
      evidence: normalizeByCanonical(
        evidenceReferences,
        packageAgentFactsEvidenceReferenceSchema.parse,
      ),
    },
    completeness,
    summary: summarizeAgentFacts(agentKey, {
      description,
      inputSchema,
      outputSchema,
      declared,
      observed,
    }),
  };
  return { record: packageAgentFactsRecordSchema.parse(record), diagnostics };
}

function snapshotWithoutId(
  snapshot: PackageAgentFactsSnapshot,
): Omit<PackageAgentFactsSnapshot, "snapshotId"> {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== "snapshotId"),
  ) as Omit<PackageAgentFactsSnapshot, "snapshotId">;
}

export const packageAgentFactsSnapshotSchema = snapshotBaseSchema.superRefine(
  (snapshot, context) => {
    const sortedAgents = [...snapshot.agents].sort((left, right) =>
      compareText(left.agentKey, right.agentKey),
    );
    if (
      new Set(sortedAgents.map((agent) => agent.agentKey)).size !==
        sortedAgents.length ||
      canonicalPackageAgentFactsJson(sortedAgents) !==
        canonicalPackageAgentFactsJson(snapshot.agents)
    ) {
      context.addIssue({
        code: "custom",
        path: ["agents"],
        message: "Agent facts must be unique and canonically ordered",
      });
    }
    for (const [index, agent] of snapshot.agents.entries()) {
      const normalized = packageAgentFactsRecordSchema.parse({
        ...agent,
        references: {
          source: normalizeByCanonical(
            agent.references.source,
            packageAgentFactsSourceReferenceSchema.parse,
          ),
          direct: normalizeByCanonical(
            agent.references.direct,
            packageAgentFactsDirectReferenceSchema.parse,
          ),
          evidence: normalizeByCanonical(
            agent.references.evidence,
            packageAgentFactsEvidenceReferenceSchema.parse,
          ),
        },
        completeness: normalizeCompleteness(agent.completeness),
      });
      if (
        canonicalPackageAgentFactsJson(normalized) !==
        canonicalPackageAgentFactsJson(agent)
      ) {
        context.addIssue({
          code: "custom",
          path: ["agents", index],
          message: "Agent facts record is not normalized",
        });
      }
    }
    if (
      canonicalPackageAgentFactsJson(
        normalizeDiagnostics(snapshot.diagnostics),
      ) !== canonicalPackageAgentFactsJson(snapshot.diagnostics)
    ) {
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Diagnostics must be unique and canonically ordered",
      });
    }
    if (
      snapshot.snapshotId !==
      packageAgentFactsSha256(snapshotWithoutId(snapshot))
    ) {
      context.addIssue({
        code: "custom",
        path: ["snapshotId"],
        message: "Snapshot ID does not match canonical snapshot content",
      });
    }
  },
);

/**
 * Normalize factual per-agent metadata against one authoritative inventory.
 *
 * The helper never discovers, remaps, or infers agent identity. It emits one
 * record for every inventory `agentKey`; missing or invalid extraction cards
 * become unknown facts with diagnostics instead of deleting the agent node.
 */
export function createPackageAgentFactsSnapshot(
  input: CreatePackageAgentFactsSnapshotInput,
  inventoryInput: PackageInventory,
): PackageAgentFactsSnapshot {
  const parsedInput = createSnapshotInputSchema.parse(input);
  const inventory = packageInventorySchema.parse(inventoryInput);
  if (!scopeMatches(parsedInput.scope, inventory.version)) {
    throw new TypeError(
      "AgentFacts snapshot scope must match the package inventory version",
    );
  }
  const cardsByAgentKey = new Map<string, PackageAgentFactsCardInput>();
  const diagnostics: PackageAgentFactsDiagnostic[] = [
    ...(parsedInput.diagnostics ?? []),
  ];
  const inventoryKeys = new Set(
    inventory.agents.map((agent) => agent.agentKey),
  );

  for (const rawCard of parsedInput.cards) {
    const parsed = cardInputSchema.safeParse(rawCard);
    if (!parsed.success) {
      diagnostics.push({ code: "invalid-card", severity: "warning" });
      continue;
    }
    const card = parsed.data;
    if (!inventoryKeys.has(card.agentKey)) {
      diagnostics.push({
        code: "unknown-agent-key",
        severity: "warning",
        agentKey: card.agentKey,
      });
      continue;
    }
    if (cardsByAgentKey.has(card.agentKey)) {
      diagnostics.push({
        code: "duplicate-card",
        severity: "warning",
        agentKey: card.agentKey,
      });
      continue;
    }
    cardsByAgentKey.set(card.agentKey, card);
  }

  const agents: PackageAgentFactsRecord[] = [];
  for (const agent of inventory.agents) {
    const card = cardsByAgentKey.get(agent.agentKey);
    if (!card) {
      const missing = {
        code: "missing-card",
        severity: "warning",
        agentKey: agent.agentKey,
      } as const;
      diagnostics.push(missing);
      agents.push(unknownRecord(agent.agentKey, [missing]));
      continue;
    }
    const { record, diagnostics: cardDiagnostics } = recordFromCard(
      agent.agentKey,
      card,
    );
    diagnostics.push(...cardDiagnostics);
    agents.push(record);
  }

  const draft: PackageAgentFactsSnapshot = {
    protocol: PACKAGE_AGENT_FACTS_PROTOCOL,
    kind: "agent-facts-snapshot",
    snapshotId: ZERO_DIGEST,
    scope: parsedInput.scope,
    extractor: parsedInput.extractor,
    inventoryStatus: inventory.status,
    agents: agents.sort((left, right) =>
      compareText(left.agentKey, right.agentKey),
    ),
    diagnostics: normalizeDiagnostics(diagnostics),
  };
  const snapshot = {
    ...draft,
    snapshotId: packageAgentFactsSha256(snapshotWithoutId(draft)),
  };
  return packageAgentFactsSnapshotSchema.parse(snapshot);
}
