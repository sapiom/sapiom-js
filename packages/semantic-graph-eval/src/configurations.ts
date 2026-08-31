import {
  experimentConfigurationSchema,
  type ExperimentConfiguration,
  type ExperimentConfigurationId,
} from "./contracts.js";
import { fingerprint } from "./fingerprint.js";

const CONFIGURATIONS = {
  "facts-only.v1": {
    id: "facts-only.v1",
    promptId: "semantic-feeds.prompt.v1",
    policyId: "semantic-feeds.precision-first.v1",
    sourceSelectionId: "facts-only.v1",
    outputSchemaId: "semantic-feeds.output.v1",
    maxSourceCharacters: 0,
    maxPacketBytes: 64_000,
    maxOutputTokens: 1_200,
  },
  "bounded-source.v1": {
    id: "bounded-source.v1",
    promptId: "semantic-feeds.prompt.v1",
    policyId: "semantic-feeds.precision-first.v1",
    sourceSelectionId: "allowlisted-source-2500.v1",
    outputSchemaId: "semantic-feeds.output.v1",
    maxSourceCharacters: 2_500,
    maxPacketBytes: 72_000,
    maxOutputTokens: 1_600,
  },
  "bounded-source.v2": {
    id: "bounded-source.v2",
    promptId: "semantic-feeds.prompt.v2",
    policyId: "semantic-feeds.precision-first.v2",
    sourceSelectionId: "allowlisted-source-2500.v1",
    outputSchemaId: "semantic-feeds.output.v1",
    maxSourceCharacters: 2_500,
    maxPacketBytes: 72_000,
    maxOutputTokens: 1_600,
  },
  "context-pressure.v1": {
    id: "context-pressure.v1",
    promptId: "semantic-feeds.prompt.v1",
    policyId: "semantic-feeds.precision-first.v1",
    sourceSelectionId: "allowlisted-source-18000.v1",
    outputSchemaId: "semantic-feeds.output.v1",
    maxSourceCharacters: 18_000,
    maxPacketBytes: 96_000,
    maxOutputTokens: 2_000,
  },
} satisfies Record<ExperimentConfigurationId, ExperimentConfiguration>;

export const EXPERIMENT_CONFIGURATION_IDS = [
  "facts-only.v1",
  "bounded-source.v1",
  "bounded-source.v2",
  "context-pressure.v1",
] as const satisfies readonly ExperimentConfigurationId[];

/** Frozen after Luna calibration; changing this requires a new experiment version. */
export const FROZEN_HOLDOUT_CONFIGURATION_ID = "bounded-source.v2" as const;

export function getConfiguration(
  id: ExperimentConfigurationId,
): ExperimentConfiguration {
  return experimentConfigurationSchema.parse(CONFIGURATIONS[id]);
}

export function getConfigurationFingerprint(
  configuration: ExperimentConfiguration,
): string {
  return fingerprint(experimentConfigurationSchema.parse(configuration));
}
