import {
  PACKET_PROTOCOL,
  type ExperimentConfiguration,
  type SemanticGraphPacket,
  type ValidatedFixtureInput,
} from "./contracts.js";
import { canonicalJson, compareText } from "./fingerprint.js";

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function selectSourceExcerpts(
  input: ValidatedFixtureInput,
  maxCharacters: number,
): SemanticGraphPacket["sourceExcerpts"] {
  let remaining = maxCharacters;
  const selected: SemanticGraphPacket["sourceExcerpts"] = [];
  for (const excerpt of input.sourceExcerpts) {
    if (remaining <= 0) break;
    const content = excerpt.content.slice(0, remaining);
    selected.push({
      ref: excerpt.ref,
      agentId: excerpt.agentId,
      language: excerpt.language,
      content,
      truncated: content.length < excerpt.content.length,
    });
    remaining -= content.length;
  }
  return selected;
}

function evidenceReference(
  evidence: ValidatedFixtureInput["phaseAEvidence"]["evidence"][number],
): string {
  return `phase-a:${evidence.evidenceId.slice("sha256:".length)}`;
}

function withMeasuredPressure(
  packet: SemanticGraphPacket,
): SemanticGraphPacket {
  const sectionBytes = {
    project: byteLength(packet.project),
    inventory: byteLength(packet.inventory),
    configuration: byteLength(packet.configuration),
    agents: byteLength(packet.agents),
    provenRelationships: byteLength(packet.provenRelationships),
    sharedContext: byteLength(packet.sharedContext),
    coverageGaps: byteLength(packet.coverageGaps),
    sourceExcerpts: byteLength(packet.sourceExcerpts),
  };
  const measured: SemanticGraphPacket = {
    ...packet,
    contextPressure: {
      ...packet.contextPressure,
      sectionBytes,
    },
  };
  let serializedBytes = 0;
  let estimatedTokens = 0;
  for (let index = 0; index < 8; index += 1) {
    measured.contextPressure.serializedBytes = serializedBytes;
    measured.contextPressure.estimatedTokens = estimatedTokens;
    const nextBytes = byteLength(measured);
    const nextTokens = Math.ceil(nextBytes / 4);
    if (nextBytes === serializedBytes && nextTokens === estimatedTokens) break;
    serializedBytes = nextBytes;
    estimatedTokens = nextTokens;
  }
  measured.contextPressure.serializedBytes = byteLength(measured);
  measured.contextPressure.estimatedTokens = Math.ceil(
    measured.contextPressure.serializedBytes / 4,
  );
  // The digit count can change once more when the final byte count is inserted.
  measured.contextPressure.serializedBytes = byteLength(measured);
  measured.contextPressure.estimatedTokens = Math.ceil(
    measured.contextPressure.serializedBytes / 4,
  );
  return measured;
}

export function buildSemanticGraphPacket(
  input: ValidatedFixtureInput,
  configuration: ExperimentConfiguration,
): SemanticGraphPacket {
  const sourceExcerpts = selectSourceExcerpts(
    input,
    configuration.maxSourceCharacters,
  );
  const provenRelationships = input.phaseAEvidence.evidence
    .map((evidence) => ({
      ref: evidenceReference(evidence),
      relationship: evidence.relation,
      sourceAgentId: evidence.fromAgentKey,
      targetAgentId: evidence.toAgentKey,
      basis: evidence.basis,
    }))
    .sort((left, right) =>
      compareText(
        `${left.sourceAgentId}\u0000${left.targetAgentId}\u0000${left.relationship}\u0000${left.ref}`,
        `${right.sourceAgentId}\u0000${right.targetAgentId}\u0000${right.relationship}\u0000${right.ref}`,
      ),
    );
  const packet: SemanticGraphPacket = {
    protocol: PACKET_PROTOCOL,
    fixtureId: input.fixtureId,
    project: input.project,
    inventory: {
      protocol: input.inventory.protocol,
      version: input.inventory.version,
      status: input.inventory.status,
    },
    configuration: {
      id: configuration.id,
      promptId: configuration.promptId,
      policyId: configuration.policyId,
      sourceSelectionId: configuration.sourceSelectionId,
      outputSchemaId: configuration.outputSchemaId,
    },
    agents: input.agentCards.map((card) => ({
      agentId: card.agentId,
      name: card.name,
      facts: card.facts.map((fact) => ({
        ref: fact.ref,
        kind: fact.kind,
        text: fact.text,
      })),
    })),
    provenRelationships,
    sharedContext: input.sharedContext.map((fact) => ({
      ref: fact.ref,
      kind: fact.kind,
      text: fact.text,
    })),
    coverageGaps: input.coverageGaps.map((gap) => ({
      ref: gap.ref,
      code: gap.code,
      agentIds: gap.agentIds,
      description: gap.description,
    })),
    sourceExcerpts,
    contextPressure: {
      sourceCharactersAvailable: input.sourceExcerpts.reduce(
        (total, excerpt) => total + excerpt.content.length,
        0,
      ),
      sourceCharactersIncluded: sourceExcerpts.reduce(
        (total, excerpt) => total + excerpt.content.length,
        0,
      ),
      omittedExcerptCount: input.sourceExcerpts.length - sourceExcerpts.length,
      truncatedExcerptCount: sourceExcerpts.filter(
        (excerpt) => excerpt.truncated,
      ).length,
      serializedBytes: 0,
      estimatedTokens: 0,
      maxPacketBytes: configuration.maxPacketBytes,
      sectionBytes: {
        project: 0,
        inventory: 0,
        configuration: 0,
        agents: 0,
        provenRelationships: 0,
        sharedContext: 0,
        coverageGaps: 0,
        sourceExcerpts: 0,
      },
    },
  };
  const measured = withMeasuredPressure(packet);
  if (measured.contextPressure.serializedBytes > configuration.maxPacketBytes) {
    throw new RangeError(
      `Packet ${input.fixtureId}/${configuration.id} is ${measured.contextPressure.serializedBytes} bytes; limit is ${configuration.maxPacketBytes}`,
    );
  }
  return measured;
}

export function visiblePacketReferences(
  packet: SemanticGraphPacket,
): Set<string> {
  return new Set([
    ...packet.agents.flatMap((agent) => agent.facts.map((fact) => fact.ref)),
    ...packet.provenRelationships.map((relationship) => relationship.ref),
    ...packet.sharedContext.map((fact) => fact.ref),
    ...packet.coverageGaps.map((gap) => gap.ref),
    ...packet.sourceExcerpts.map((excerpt) => excerpt.ref),
  ]);
}
