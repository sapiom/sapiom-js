import { resolve } from "node:path";

import type {
  ExperimentConfigurationId,
  LoadedFixture,
  ProviderRequest,
} from "../contracts.js";
import {
  getConfiguration,
  getConfigurationFingerprint,
} from "../configurations.js";
import { loadCorpus } from "../fixture-loader.js";
import { fingerprint } from "../fingerprint.js";
import { buildSemanticGraphPacket } from "../packet.js";
import { buildSemanticPrompt } from "../prompt.js";

export const FIXTURE_ROOT = resolve(__dirname, "../../fixtures/v1");

export async function corpus(): Promise<LoadedFixture[]> {
  return loadCorpus(FIXTURE_ROOT);
}

export function fixtureById(
  fixtures: LoadedFixture[],
  fixtureId: string,
): LoadedFixture {
  const fixture = fixtures.find((item) => item.input.fixtureId === fixtureId);
  if (!fixture) throw new TypeError(`Missing test fixture ${fixtureId}`);
  return fixture;
}

export function requestFor(
  fixture: LoadedFixture,
  configurationId: ExperimentConfigurationId = "bounded-source.v1",
): ProviderRequest {
  const configuration = getConfiguration(configurationId);
  const packet = buildSemanticGraphPacket(fixture.input, configuration);
  const prompt = buildSemanticPrompt(packet);
  return {
    fixtureId: fixture.input.fixtureId,
    requestedModel: "gpt-luna",
    configuration,
    configurationFingerprint: getConfigurationFingerprint(configuration),
    inputFingerprint: fixture.inputFingerprint,
    packetFingerprint: fingerprint(packet),
    promptFingerprint: fingerprint(prompt),
    packet,
    prompt,
  };
}
