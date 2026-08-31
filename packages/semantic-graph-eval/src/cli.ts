import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod/v4";

import {
  EXPERIMENT_CONFIGURATION_IDS,
  FROZEN_HOLDOUT_CONFIGURATION_ID,
  getConfiguration,
} from "./configurations.js";
import {
  type EvaluationAggregateReport,
  type ExperimentConfigurationId,
  type FixtureRole,
} from "./contracts.js";
import { executeFixtureEvaluation } from "./evaluate.js";
import { loadCorpus } from "./fixture-loader.js";
import { fingerprint } from "./fingerprint.js";
import type { SemanticGraphProvider } from "./provider.js";
import { MockSemanticGraphProvider } from "./providers/mock.js";
import {
  SapiomLunaProvider,
  assertRealEvaluationEnabled,
} from "./providers/sapiom-luna.js";
import {
  createAggregateReport,
  createRunReport,
  serializeReport,
} from "./report.js";

const mockBaselineSchema = z
  .object({
    protocol: z.literal("semantic-graph-eval.mock-baseline/1"),
    aggregateFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

interface CliOptions {
  provider: "mock" | "luna";
  configuration: ExperimentConfigurationId | null;
  fixtureSet: FixtureRole | "all";
  fixtureRoot: string;
  outputPath: string | null;
}

export interface CliDependencies {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  stdout?: (line: string) => void;
  provider?: SemanticGraphProvider;
}

export interface CliResult {
  report: EvaluationAggregateReport;
  outputPath: string;
  invocationCount: number;
}

function defaultFixtureRoot(): string {
  const candidates = [
    resolve(process.cwd(), "fixtures/v1"),
    resolve(__dirname, "../../fixtures/v1"),
    resolve(__dirname, "../fixtures/v1"),
  ];
  const found = candidates.find((candidate) =>
    existsSync(resolve(candidate, "corpus-manifest.json")),
  );
  if (!found) {
    throw new Error("Could not locate fixtures/v1/corpus-manifest.json");
  }
  return found;
}

function configurationId(value: string): ExperimentConfigurationId {
  if (
    !EXPERIMENT_CONFIGURATION_IDS.includes(value as ExperimentConfigurationId)
  ) {
    throw new TypeError(`Unknown configuration: ${value}`);
  }
  return value as ExperimentConfigurationId;
}

export function parseCliOptions(args: string[]): CliOptions {
  let provider: CliOptions["provider"] = "mock";
  let configuration: ExperimentConfigurationId | null = null;
  let fixtureSet: CliOptions["fixtureSet"] = "all";
  let fixtureRoot: string | null = null;
  let outputPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    // pnpm may preserve its conventional argument separator for this script.
    if (flag === "--") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    if (flag === "--provider") {
      if (value !== "mock" && value !== "luna") {
        throw new TypeError(`Unknown provider: ${value}`);
      }
      provider = value;
    } else if (flag === "--configuration") {
      configuration = configurationId(value);
    } else if (flag === "--set") {
      if (value !== "calibration" && value !== "holdout" && value !== "all") {
        throw new TypeError(`Unknown fixture set: ${value}`);
      }
      fixtureSet = value;
    } else if (flag === "--fixtures") {
      fixtureRoot = resolve(value);
    } else if (flag === "--output") {
      outputPath = resolve(value);
    } else {
      throw new TypeError(`Unknown argument: ${flag}`);
    }
    index += 1;
  }
  return {
    provider,
    configuration,
    fixtureSet,
    fixtureRoot: fixtureRoot ?? defaultFixtureRoot(),
    outputPath,
  };
}

function realOutputPath(options: CliOptions, now: () => number): string {
  const startedAtMs = now();
  const identity = fingerprint({
    provider: options.provider,
    configuration: options.configuration,
    fixtureSet: options.fixtureSet,
    startedAtMs,
  }).slice("sha256:".length, "sha256:".length + 12);
  return resolve(
    process.cwd(),
    ".temp/semantic-graph-eval",
    `${startedAtMs}-${identity}`,
    "report.json",
  );
}

async function assertMockBaseline(
  fixtureRoot: string,
  report: EvaluationAggregateReport,
): Promise<void> {
  const baseline = mockBaselineSchema.parse(
    JSON.parse(
      await readFile(resolve(fixtureRoot, "mock-baseline.json"), "utf8"),
    ) as unknown,
  );
  const actual = fingerprint(report);
  if (actual !== baseline.aggregateFingerprint) {
    throw new Error(
      `Deterministic mock baseline drift: expected ${baseline.aggregateFingerprint}, received ${actual}`,
    );
  }
}

export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  const options = parseCliOptions(args);
  const environment = dependencies.environment ?? process.env;
  const now = dependencies.now ?? Date.now;
  const stdout = dependencies.stdout ?? console.log;
  if (options.provider === "luna") {
    assertRealEvaluationEnabled(environment);
    if (options.configuration === null) {
      throw new Error("Luna evaluation requires --configuration");
    }
    if (options.fixtureSet === "all") {
      throw new Error(
        "Luna evaluation requires --set calibration or --set holdout",
      );
    }
    if (
      options.fixtureSet === "holdout" &&
      options.configuration !== FROZEN_HOLDOUT_CONFIGURATION_ID
    ) {
      throw new Error(
        `Holdout is frozen to ${FROZEN_HOLDOUT_CONFIGURATION_ID}; another configuration is not permitted`,
      );
    }
  }

  const corpus = await loadCorpus(options.fixtureRoot);
  const fixtures = corpus.filter(
    (fixture) =>
      options.fixtureSet === "all" || fixture.input.role === options.fixtureSet,
  );
  if (fixtures.length === 0)
    throw new Error("No fixtures matched the selection");
  const configurationIds =
    options.configuration === null
      ? [...EXPERIMENT_CONFIGURATION_IDS]
      : [options.configuration];
  const mockProvider =
    options.provider === "mock" && dependencies.provider === undefined
      ? new MockSemanticGraphProvider(corpus)
      : null;
  const provider =
    dependencies.provider ??
    mockProvider ??
    new SapiomLunaProvider({ environment });
  const runReports = [];
  for (const fixture of fixtures) {
    for (const id of configurationIds) {
      const evaluation = await executeFixtureEvaluation(
        fixture,
        getConfiguration(id),
        provider,
      );
      runReports.push(createRunReport(fixture, evaluation));
    }
  }
  const expectedInvocationCount = fixtures.length * configurationIds.length;
  const invocationCount =
    mockProvider?.totalInvocationCount ?? expectedInvocationCount;
  if (mockProvider) {
    if (invocationCount !== expectedInvocationCount) {
      throw new Error(
        `Expected ${expectedInvocationCount} mock calls, received ${invocationCount}`,
      );
    }
    for (const count of mockProvider.invocationCounts.values()) {
      if (count !== 1)
        throw new Error("A mock run identity was invoked more than once");
    }
  }
  const report = createAggregateReport({
    provider: options.provider === "mock" ? "mock" : "sapiom-luna",
    fixtureSet: options.fixtureSet,
    fixtures,
    reports: runReports,
  });
  const isFullMockMatrix =
    options.provider === "mock" &&
    options.fixtureSet === "all" &&
    options.configuration === null;
  if (isFullMockMatrix) await assertMockBaseline(options.fixtureRoot, report);
  const outputPath =
    options.outputPath ??
    (options.provider === "mock"
      ? resolve(process.cwd(), ".temp/semantic-graph-eval/mock/report.json")
      : realOutputPath(options, now));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeReport(report), "utf8");
  stdout(
    `semantic-graph-eval provider=${report.provider} runs=${report.metrics.runs} precision=${String(report.metrics.precision)} recall=${String(report.metrics.recall)} failures=${report.metrics.providerFailures} output=${outputPath}`,
  );
  if (
    options.provider === "luna" &&
    (report.metrics.providerFailures > 0 ||
      report.metrics.malformedAttempts > 0)
  ) {
    throw new Error(
      `Luna evaluation recorded ${report.metrics.providerFailures} provider failure(s) and ${report.metrics.malformedAttempts} malformed attempt(s); sanitized report: ${outputPath}`,
    );
  }
  return { report, outputPath, invocationCount };
}

if (typeof require !== "undefined" && require.main === module) {
  void runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown evaluation error";
    process.stderr.write(`semantic-graph-eval: ${message}\n`);
    process.exitCode = 1;
  });
}
