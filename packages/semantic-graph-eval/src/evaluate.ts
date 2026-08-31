import type {
  AcceptedSemanticSnapshot,
  EvaluationMetrics,
  ExperimentConfiguration,
  FixtureOracle,
  LoadedFixture,
  ProviderAttempt,
  ProviderRequest,
  SemanticGraphPacket,
  SemanticPrompt,
} from "./contracts.js";
import { getConfigurationFingerprint } from "./configurations.js";
import { fingerprint } from "./fingerprint.js";
import { buildSemanticGraphPacket } from "./packet.js";
import { buildSemanticPrompt } from "./prompt.js";
import { REQUESTED_MODEL, type SemanticGraphProvider } from "./provider.js";
import { validateProviderAttempt } from "./validation.js";

function pairKey(sourceAgentId: string, targetAgentId: string): string {
  return `${sourceAgentId}\u0000${targetAgentId}`;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

export function scoreSnapshot(
  snapshot: AcceptedSemanticSnapshot,
  oracle: FixtureOracle,
): EvaluationMetrics {
  const expected = new Set(
    oracle.expectedFeeds.map((pair) =>
      pairKey(pair.sourceAgentId, pair.targetAgentId),
    ),
  );
  const accepted = new Set(
    snapshot.accepted.map((candidate) =>
      pairKey(candidate.sourceAgentId, candidate.targetAgentId),
    ),
  );
  let truePositives = 0;
  for (const pair of accepted) {
    if (expected.has(pair)) truePositives += 1;
  }
  const falsePositives = accepted.size - truePositives;
  const falseNegatives = expected.size - truePositives;
  const precision = ratio(truePositives, accepted.size);
  const recall = ratio(truePositives, expected.size);
  const f1 =
    precision === null || recall === null
      ? null
      : precision + recall === 0
        ? 0
        : Number(((2 * precision * recall) / (precision + recall)).toFixed(6));
  const forbidden = new Map(
    oracle.forbiddenFeeds.map((pair) => [
      pairKey(pair.sourceAgentId, pair.targetAgentId),
      pair.category,
    ]),
  );
  const falsePositiveCategories: EvaluationMetrics["falsePositiveCategories"] =
    {};
  for (const pair of accepted) {
    if (expected.has(pair)) continue;
    const category = forbidden.get(pair) ?? "unexpected";
    falsePositiveCategories[category] =
      (falsePositiveCategories[category] ?? 0) + 1;
  }
  const abstained =
    snapshot.attemptStatus === "accepted" &&
    snapshot.outcome === "abstained" &&
    snapshot.accepted.length === 0;
  const abstention = abstained
    ? oracle.expectedOutcome === "abstained"
      ? "correct"
      : "incorrect"
    : "not-applicable";
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    correctAbstention: abstention === "correct",
    abstention,
    falsePositiveCategories,
  };
}

export interface ExecutedEvaluation {
  request: ProviderRequest;
  packet: SemanticGraphPacket;
  prompt: SemanticPrompt;
  attempt: ProviderAttempt;
  snapshot: AcceptedSemanticSnapshot;
  metrics: EvaluationMetrics;
}

export async function executeFixtureEvaluation(
  fixture: LoadedFixture,
  configuration: ExperimentConfiguration,
  provider: SemanticGraphProvider,
): Promise<ExecutedEvaluation> {
  const packet = buildSemanticGraphPacket(fixture.input, configuration);
  const prompt = buildSemanticPrompt(packet);
  const request: ProviderRequest = {
    fixtureId: fixture.input.fixtureId,
    requestedModel: REQUESTED_MODEL,
    configuration,
    configurationFingerprint: getConfigurationFingerprint(configuration),
    inputFingerprint: fixture.inputFingerprint,
    packetFingerprint: fingerprint(packet),
    promptFingerprint: fingerprint(prompt),
    packet,
    prompt,
  };
  // Deliberately exactly one invocation. There is no retry or repair branch.
  const attempt = await provider.invoke(request);
  if (attempt.requestedModel !== request.requestedModel) {
    throw new TypeError("Provider attempt requested-model identity mismatch");
  }
  const snapshot = validateProviderAttempt(request, attempt);
  return {
    request,
    packet,
    prompt,
    attempt,
    snapshot,
    metrics: scoreSnapshot(snapshot, fixture.oracle),
  };
}

export function evaluationRunFingerprint(
  evaluation: ExecutedEvaluation,
): string {
  return fingerprint({
    request: {
      fixtureId: evaluation.request.fixtureId,
      configurationFingerprint: evaluation.request.configurationFingerprint,
      inputFingerprint: evaluation.request.inputFingerprint,
      packetFingerprint: evaluation.request.packetFingerprint,
      promptFingerprint: evaluation.request.promptFingerprint,
      requestedModel: evaluation.request.requestedModel,
    },
    packet: evaluation.packet,
    prompt: evaluation.prompt,
    snapshot: evaluation.snapshot,
    metrics: evaluation.metrics,
  });
}
