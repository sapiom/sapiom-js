import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EXPERIMENT_CONFIGURATION_IDS,
  getConfiguration,
  getConfigurationFingerprint,
} from "../configurations.js";
import { canonicalJson } from "../fingerprint.js";
import { buildSemanticGraphPacket } from "../packet.js";
import { corpus, fixtureById } from "./test-helpers.js";

describe("semantic packet normalization", () => {
  it("matches the committed facts-only packet golden exactly", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "complete-abstention");
    const packet = buildSemanticGraphPacket(
      fixture.input,
      getConfiguration("facts-only.v1"),
    );
    const golden = await readFile(
      resolve(__dirname, "goldens/complete-abstention.facts-only.packet.json"),
      "utf8",
    );
    expect(`${JSON.stringify(packet, null, 2)}\n`).toBe(golden);
  });

  it("is byte-identical across builds and accounts for exact packet pressure", async () => {
    const fixture = fixtureById(await corpus(), "mixed-project-stress");
    const configuration = getConfiguration("bounded-source.v1");
    const first = buildSemanticGraphPacket(fixture.input, configuration);
    const second = buildSemanticGraphPacket(fixture.input, configuration);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.inventory).toEqual({
      protocol: fixture.input.inventory.protocol,
      version: fixture.input.inventory.version,
      status: fixture.input.inventory.status,
    });
    expect(first.contextPressure.serializedBytes).toBe(
      Buffer.byteLength(canonicalJson(first), "utf8"),
    );
    expect(first.contextPressure.estimatedTokens).toBe(
      Math.ceil(first.contextPressure.serializedBytes / 4),
    );
    expect(first.agents.map((agent) => agent.agentId)).toEqual(
      [...first.agents.map((agent) => agent.agentId)].sort(),
    );
  });

  it("applies the three source-selection budgets without exposing source paths", async () => {
    const fixture = fixtureById(await corpus(), "truncated-context");
    const factsOnly = buildSemanticGraphPacket(
      fixture.input,
      getConfiguration("facts-only.v1"),
    );
    const bounded = buildSemanticGraphPacket(
      fixture.input,
      getConfiguration("bounded-source.v1"),
    );
    const pressure = buildSemanticGraphPacket(
      fixture.input,
      getConfiguration("context-pressure.v1"),
    );
    expect(factsOnly.sourceExcerpts).toEqual([]);
    expect(bounded.contextPressure.sourceCharactersIncluded).toBe(2_500);
    expect(bounded.contextPressure.truncatedExcerptCount).toBe(1);
    expect(pressure.contextPressure.sourceCharactersIncluded).toBeGreaterThan(
      bounded.contextPressure.sourceCharactersIncluded,
    );
    expect(pressure.sourceExcerpts[0]).not.toHaveProperty("path");
    expect(canonicalJson(pressure.sourceExcerpts)).not.toContain('"path"');
  });

  it("gives every configuration a stable and distinct identity", () => {
    const fingerprints = EXPERIMENT_CONFIGURATION_IDS.map((id) =>
      getConfigurationFingerprint(getConfiguration(id)),
    );
    expect(new Set(fingerprints).size).toBe(
      EXPERIMENT_CONFIGURATION_IDS.length,
    );
    expect(fingerprints).toEqual(
      EXPERIMENT_CONFIGURATION_IDS.map((id) =>
        getConfigurationFingerprint(getConfiguration(id)),
      ),
    );
  });
});
