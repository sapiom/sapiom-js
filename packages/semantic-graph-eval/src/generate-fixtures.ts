import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  MANIFEST_PROTOCOL,
  corpusManifestSchema,
  fixtureInputSchema,
  fixtureOracleSchema,
  mockProviderFixtureSchema,
  type CorpusManifest,
} from "./contracts.js";
import { fixtureDefinitions } from "./fixture-definitions.js";
import { normalizeFixtureInput } from "./fixture-loader.js";
import { fingerprintText } from "./fingerprint.js";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function generateFixtures(
  fixtureRoot = resolve(process.cwd(), "fixtures", "v1"),
): Promise<CorpusManifest> {
  const cases: CorpusManifest["cases"] = [];
  for (const definition of fixtureDefinitions()) {
    const input = normalizeFixtureInput(
      fixtureInputSchema.parse(definition.input),
    );
    const oracle = fixtureOracleSchema.parse(definition.oracle);
    const providerFixture = mockProviderFixtureSchema.parse(
      definition.providerFixture,
    );
    const inputJson = json(input);
    const oracleJson = json(oracle);
    const providerJson = json(providerFixture);
    const caseRoot = resolve(fixtureRoot, "cases", input.fixtureId);
    await mkdir(caseRoot, { recursive: true });
    await Promise.all([
      writeFile(resolve(caseRoot, "input.json"), inputJson),
      writeFile(resolve(caseRoot, "oracle.json"), oracleJson),
      writeFile(resolve(caseRoot, "provider-response.json"), providerJson),
    ]);
    cases.push({
      fixtureId: input.fixtureId,
      role: input.role,
      categories: input.categories,
      inputFingerprint: fingerprintText(inputJson),
      oracleFingerprint: fingerprintText(oracleJson),
      providerResponseFingerprint: fingerprintText(providerJson),
    });
  }
  const manifest = corpusManifestSchema.parse({
    protocol: MANIFEST_PROTOCOL,
    cases,
  });
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(resolve(fixtureRoot, "corpus-manifest.json"), json(manifest));
  return manifest;
}

if (typeof require !== "undefined" && require.main === module) {
  generateFixtures()
    .then((manifest) => {
      process.stdout.write(
        `Generated ${manifest.cases.length} immutable semantic graph fixtures.\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
