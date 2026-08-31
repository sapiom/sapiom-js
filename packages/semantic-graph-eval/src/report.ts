import {
  MANIFEST_PROTOCOL,
  REPORT_PROTOCOL,
  type AcceptedSemanticSnapshot,
  type EvaluationAggregateMetrics,
  type EvaluationAggregateReport,
  type EvaluationRunReport,
  type ExperimentConfigurationId,
  type FixtureRole,
  type LoadedFixture,
  type RejectionCode,
} from "./contracts.js";
import type { ExecutedEvaluation } from "./evaluate.js";
import { canonicalJson, compareText, fingerprint } from "./fingerprint.js";

export function normalizedOutputFingerprint(
  snapshot: AcceptedSemanticSnapshot,
): string {
  return fingerprint({
    protocol: "semantic-graph-eval.normalized-output/1",
    attemptStatus: snapshot.attemptStatus,
    providerErrorCode: snapshot.providerErrorCode,
    outcome: snapshot.outcome,
    accepted: snapshot.accepted,
    rejected: snapshot.rejected,
  });
}

export function createRunReport(
  fixture: LoadedFixture,
  evaluation: ExecutedEvaluation,
): EvaluationRunReport {
  return {
    protocol: REPORT_PROTOCOL,
    fixtureId: fixture.input.fixtureId,
    role: fixture.input.role,
    categories: [...fixture.input.categories],
    configurationId: evaluation.request.configuration.id,
    inputFingerprint: fixture.inputFingerprint,
    configurationFingerprint: evaluation.request.configurationFingerprint,
    packetFingerprint: evaluation.request.packetFingerprint,
    promptFingerprint: evaluation.request.promptFingerprint,
    outputFingerprint: normalizedOutputFingerprint(evaluation.snapshot),
    requestedModel: evaluation.attempt.requestedModel,
    providerLatencyMs:
      evaluation.attempt.status === "success"
        ? evaluation.attempt.usage.latencyMs
        : evaluation.attempt.latencyMs,
    snapshot: evaluation.snapshot,
    metrics: evaluation.metrics,
    usage:
      evaluation.attempt.status === "success" ? evaluation.attempt.usage : null,
    contextPressure: evaluation.packet.contextPressure,
  };
}

function sumNullable(
  reports: EvaluationRunReport[],
  select: (report: EvaluationRunReport) => number | null,
): number | null {
  const values = reports.map(select);
  if (values.some((value) => value === null)) return null;
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : Number(present.reduce((total, value) => total + value, 0).toFixed(8));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0
    ? null
    : Number((numerator / denominator).toFixed(6));
}

export function aggregateMetrics(
  reports: EvaluationRunReport[],
): EvaluationAggregateMetrics {
  const truePositives = reports.reduce(
    (total, report) => total + report.metrics.truePositives,
    0,
  );
  const falsePositives = reports.reduce(
    (total, report) => total + report.metrics.falsePositives,
    0,
  );
  const falseNegatives = reports.reduce(
    (total, report) => total + report.metrics.falseNegatives,
    0,
  );
  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  const rejectionCodes: Partial<Record<RejectionCode, number>> = {};
  const falsePositiveCategories: EvaluationAggregateMetrics["falsePositiveCategories"] =
    {};
  for (const report of reports) {
    for (const rejected of report.snapshot.rejected) {
      rejectionCodes[rejected.code] = (rejectionCodes[rejected.code] ?? 0) + 1;
    }
    for (const [category, count] of Object.entries(
      report.metrics.falsePositiveCategories,
    )) {
      const key = category as keyof typeof falsePositiveCategories;
      falsePositiveCategories[key] =
        (falsePositiveCategories[key] ?? 0) + (count ?? 0);
    }
  }
  return {
    runs: reports.length,
    providerFailures: reports.filter(
      (report) => report.snapshot.attemptStatus === "provider-failure",
    ).length,
    malformedAttempts: reports.filter(
      (report) => report.snapshot.attemptStatus === "malformed",
    ).length,
    acceptedCandidates: reports.reduce(
      (total, report) => total + report.snapshot.accepted.length,
      0,
    ),
    rejectedCandidates: reports.reduce(
      (total, report) => total + report.snapshot.rejected.length,
      0,
    ),
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1:
      precision === null || recall === null
        ? null
        : precision + recall === 0
          ? 0
          : Number(
              ((2 * precision * recall) / (precision + recall)).toFixed(6),
            ),
    correctAbstentions: reports.filter(
      (report) => report.metrics.abstention === "correct",
    ).length,
    incorrectAbstentions: reports.filter(
      (report) => report.metrics.abstention === "incorrect",
    ).length,
    rejectionCodes,
    falsePositiveCategories,
    inputTokens: sumNullable(
      reports,
      (report) => report.usage?.inputTokens ?? null,
    ),
    outputTokens: sumNullable(
      reports,
      (report) => report.usage?.outputTokens ?? null,
    ),
    costUsd: sumNullable(reports, (report) => report.usage?.costUsd ?? null),
    latencyMs: Number(
      reports
        .reduce((total, report) => total + report.providerLatencyMs, 0)
        .toFixed(3),
    ),
  };
}

function groupedMetrics<TKey extends string>(
  reports: EvaluationRunReport[],
  keys: readonly TKey[],
  select: (report: EvaluationRunReport) => TKey,
): Partial<Record<TKey, EvaluationAggregateMetrics>> {
  return Object.fromEntries(
    keys
      .map(
        (key) =>
          [key, reports.filter((report) => select(report) === key)] as const,
      )
      .filter(([, selected]) => selected.length > 0)
      .map(([key, selected]) => [key, aggregateMetrics(selected)]),
  ) as Partial<Record<TKey, EvaluationAggregateMetrics>>;
}

export function createAggregateReport(options: {
  provider: "mock" | "sapiom-luna";
  fixtureSet: "calibration" | "holdout" | "all";
  fixtures: LoadedFixture[];
  reports: EvaluationRunReport[];
}): EvaluationAggregateReport {
  const reports = [...options.reports].sort((left, right) =>
    compareText(
      `${left.fixtureId}\u0000${left.configurationId}`,
      `${right.fixtureId}\u0000${right.configurationId}`,
    ),
  );
  const configurationIds = [
    ...new Set(reports.map((report) => report.configurationId)),
  ].sort(compareText) as ExperimentConfigurationId[];
  const fixtureRoles = [
    "calibration",
    "holdout",
  ] as const satisfies readonly FixtureRole[];
  return {
    protocol: REPORT_PROTOCOL,
    corpusProtocol: MANIFEST_PROTOCOL,
    provider: options.provider,
    requestedModel: "gpt-luna",
    fixtureSet: options.fixtureSet,
    configurationIds,
    corpusFingerprint: fingerprint(
      [...options.fixtures]
        .sort((left, right) =>
          compareText(left.input.fixtureId, right.input.fixtureId),
        )
        .map((fixture) => ({
          fixtureId: fixture.input.fixtureId,
          role: fixture.input.role,
          inputFingerprint: fixture.inputFingerprint,
          oracleFingerprint: fixture.oracleFingerprint,
          providerResponseFingerprint: fixture.providerResponseFingerprint,
        })),
    ),
    runFingerprints: reports.map((report) => fingerprint(report)),
    metrics: aggregateMetrics(reports),
    metricsByRole: groupedMetrics(
      reports,
      fixtureRoles,
      (report) => report.role,
    ),
    metricsByConfiguration: groupedMetrics(
      reports,
      configurationIds,
      (report) => report.configurationId,
    ),
    runs: reports,
  };
}

export function serializeReport(report: EvaluationAggregateReport): string {
  return `${canonicalJson(report)}\n`;
}
