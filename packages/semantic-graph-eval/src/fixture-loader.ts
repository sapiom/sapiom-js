import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  packageGraphEvidenceStaticResultSchema,
  packageInventorySchema,
} from "@sapiom/agent";

import {
  corpusManifestSchema,
  fixtureInputSchema,
  fixtureOracleSchema,
  mockProviderFixtureSchema,
  type CorpusManifest,
  type FixtureInput,
  type LoadedFixture,
  type ValidatedFixtureInput,
} from "./contracts.js";
import { canonicalJson, compareText, fingerprintText } from "./fingerprint.js";

async function readJson(
  path: string,
): Promise<{ raw: string; value: unknown }> {
  const raw = await readFile(path, "utf8");
  return { raw, value: JSON.parse(raw) as unknown };
}

function assertUniqueReferences(input: ValidatedFixtureInput): void {
  const seen = new Set<string>();
  const references = [
    ...input.agentCards.flatMap((card) => card.facts.map((fact) => fact.ref)),
    ...input.sharedContext.map((fact) => fact.ref),
    ...input.coverageGaps.map((gap) => gap.ref),
    ...input.sourceExcerpts.map((excerpt) => excerpt.ref),
  ];
  for (const reference of references) {
    if (seen.has(reference)) {
      throw new TypeError(`Duplicate model-visible reference: ${reference}`);
    }
    seen.add(reference);
  }
}

export function normalizeFixtureInput(
  input: FixtureInput,
): ValidatedFixtureInput {
  const inventory = packageInventorySchema.parse(input.inventory);
  const phaseAEvidence = packageGraphEvidenceStaticResultSchema.parse(
    input.phaseAEvidence,
  );
  if (
    canonicalJson(phaseAEvidence.scope) !== canonicalJson(inventory.version)
  ) {
    throw new TypeError("Phase A evidence scope does not match inventory");
  }
  const inventoryIds = inventory.agents.map((agent) => agent.agentKey).sort();
  const cardIds = input.agentCards.map((card) => card.agentId).sort();
  if (canonicalJson(cardIds) !== canonicalJson(inventoryIds)) {
    throw new TypeError(
      "Agent cards must enumerate the exact package inventory",
    );
  }
  const knownAgents = new Set(inventoryIds);
  for (const gap of input.coverageGaps) {
    for (const agentId of gap.agentIds) {
      if (!knownAgents.has(agentId)) {
        throw new TypeError(
          `Coverage gap references unknown agent: ${agentId}`,
        );
      }
    }
  }
  for (const excerpt of input.sourceExcerpts) {
    if (!knownAgents.has(excerpt.agentId)) {
      throw new TypeError(
        `Source excerpt references unknown agent: ${excerpt.agentId}`,
      );
    }
  }
  const normalized: ValidatedFixtureInput = {
    ...input,
    inventory,
    phaseAEvidence,
    categories: [...input.categories].sort(compareText),
    agentCards: [...input.agentCards]
      .map((card) => ({
        ...card,
        facts: [...card.facts].sort((left, right) =>
          compareText(left.ref, right.ref),
        ),
      }))
      .sort((left, right) => compareText(left.agentId, right.agentId)),
    sharedContext: [...input.sharedContext].sort((left, right) =>
      compareText(left.ref, right.ref),
    ),
    coverageGaps: [...input.coverageGaps]
      .map((gap) => ({
        ...gap,
        agentIds: [...gap.agentIds].sort(compareText),
      }))
      .sort((left, right) => compareText(left.ref, right.ref)),
    sourceExcerpts: [...input.sourceExcerpts].sort((left, right) =>
      compareText(left.ref, right.ref),
    ),
  };
  assertUniqueReferences(normalized);
  return normalized;
}

function assertOracle(
  fixture: ValidatedFixtureInput,
  oracle: LoadedFixture["oracle"],
): void {
  if (oracle.fixtureId !== fixture.fixtureId) {
    throw new TypeError("Oracle fixture identity mismatch");
  }
  if (
    (oracle.expectedOutcome === "abstained" &&
      oracle.expectedFeeds.length !== 0) ||
    (oracle.expectedOutcome === "proposals" &&
      oracle.expectedFeeds.length === 0)
  ) {
    throw new TypeError("Oracle outcome does not match expected feeds");
  }
  const knownAgents = new Set(
    fixture.inventory.agents.map((agent) => agent.agentKey),
  );
  const seenPairs = new Set<string>();
  for (const pair of [...oracle.expectedFeeds, ...oracle.forbiddenFeeds]) {
    if (pair.sourceAgentId === pair.targetAgentId) {
      throw new TypeError("Oracle relationship cannot be a self-link");
    }
    const key = `${pair.sourceAgentId}\u0000${pair.targetAgentId}`;
    if (seenPairs.has(key)) {
      throw new TypeError("Oracle contains a duplicate or conflicting pair");
    }
    seenPairs.add(key);
    if (
      !knownAgents.has(pair.sourceAgentId) ||
      !knownAgents.has(pair.targetAgentId)
    ) {
      if (!("category" in pair && pair.category === "invented-endpoint")) {
        throw new TypeError("Oracle relationship references unknown endpoint");
      }
    }
  }
}

export async function loadFixture(
  fixtureRoot: string,
  entry: CorpusManifest["cases"][number],
): Promise<LoadedFixture> {
  const caseRoot = join(fixtureRoot, "cases", entry.fixtureId);
  const [inputDocument, oracleDocument, providerDocument] = await Promise.all([
    readJson(join(caseRoot, "input.json")),
    readJson(join(caseRoot, "oracle.json")),
    readJson(join(caseRoot, "provider-response.json")),
  ]);
  const inputFingerprint = fingerprintText(inputDocument.raw);
  const oracleFingerprint = fingerprintText(oracleDocument.raw);
  const providerResponseFingerprint = fingerprintText(providerDocument.raw);
  if (
    inputFingerprint !== entry.inputFingerprint ||
    oracleFingerprint !== entry.oracleFingerprint ||
    providerResponseFingerprint !== entry.providerResponseFingerprint
  ) {
    throw new TypeError(`Immutable fixture hash mismatch: ${entry.fixtureId}`);
  }
  const input = normalizeFixtureInput(
    fixtureInputSchema.parse(inputDocument.value),
  );
  const oracle = fixtureOracleSchema.parse(oracleDocument.value);
  const providerFixture = mockProviderFixtureSchema.parse(
    providerDocument.value,
  );
  if (
    input.fixtureId !== entry.fixtureId ||
    input.role !== entry.role ||
    canonicalJson(input.categories) !==
      canonicalJson([...entry.categories].sort(compareText))
  ) {
    throw new TypeError(`Manifest identity mismatch for ${entry.fixtureId}`);
  }
  if (providerFixture.fixtureId !== input.fixtureId) {
    throw new TypeError("Provider fixture identity mismatch");
  }
  assertOracle(input, oracle);
  return {
    input,
    oracle,
    providerFixture,
    inputFingerprint,
    oracleFingerprint,
    providerResponseFingerprint,
  };
}

export async function loadCorpus(
  fixtureRoot: string,
): Promise<LoadedFixture[]> {
  const manifestDocument = await readJson(
    join(fixtureRoot, "corpus-manifest.json"),
  );
  const manifest = corpusManifestSchema.parse(manifestDocument.value);
  const ids = manifest.cases.map((entry) => entry.fixtureId);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Corpus manifest contains duplicate fixture IDs");
  }
  const caseDirectories = (
    await readdir(join(fixtureRoot, "cases"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareText);
  if (
    canonicalJson(caseDirectories) !== canonicalJson([...ids].sort(compareText))
  ) {
    throw new TypeError(
      "Corpus contains an unmanifested or missing fixture directory",
    );
  }
  const fixtures = await Promise.all(
    manifest.cases.map((entry) => loadFixture(fixtureRoot, entry)),
  );
  return fixtures.sort((left, right) =>
    compareText(left.input.fixtureId, right.input.fixtureId),
  );
}
