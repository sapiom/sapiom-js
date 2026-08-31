import {
  EXPERIMENT_CONFIGURATION_IDS,
  getConfiguration,
} from "../configurations.js";
import { executeFixtureEvaluation } from "../evaluate.js";
import { fingerprint } from "../fingerprint.js";
import { MockSemanticGraphProvider } from "../providers/mock.js";
import {
  createAggregateReport,
  createRunReport,
  serializeReport,
} from "../report.js";
import { corpus } from "./test-helpers.js";

describe("normalized reporting", () => {
  it("emits the exact deterministic full-matrix baseline", async () => {
    const fixtures = await corpus();
    const provider = new MockSemanticGraphProvider(fixtures);
    const runs = [];
    for (const fixture of fixtures) {
      for (const configurationId of EXPERIMENT_CONFIGURATION_IDS) {
        const evaluation = await executeFixtureEvaluation(
          fixture,
          getConfiguration(configurationId),
          provider,
        );
        runs.push(createRunReport(fixture, evaluation));
      }
    }
    const report = createAggregateReport({
      provider: "mock",
      fixtureSet: "all",
      fixtures,
      reports: runs,
    });
    expect(provider.totalInvocationCount).toBe(72);
    expect(report.metrics).toMatchObject({
      runs: 72,
      providerFailures: 4,
      malformedAttempts: 4,
      acceptedCandidates: 27,
      rejectedCandidates: 18,
      truePositives: 24,
      falsePositives: 3,
      falseNegatives: 16,
      precision: 0.888889,
      recall: 0.6,
      f1: 0.716418,
      correctAbstentions: 25,
      incorrectAbstentions: 13,
    });
    expect(report.metricsByConfiguration["bounded-source.v1"]).toMatchObject({
      precision: 1,
      recall: 0.8,
      truePositives: 8,
      falsePositives: 0,
    });
    expect(report.metricsByConfiguration["context-pressure.v1"]).toMatchObject({
      precision: 0.727273,
      falsePositives: 3,
    });
    expect(report.metricsByConfiguration["facts-only.v1"]).toMatchObject({
      precision: null,
      recall: 0,
    });
    expect(fingerprint(report)).toBe(
      "sha256:82e6615a7b1868677a67b9004cdfab8c86cfd6dfce961beabf420bd0141b4cc5",
    );
    expect(serializeReport(report)).toBe(serializeReport(report));
  });

  it("contains normalized evidence only, with no prompt, packet, or raw response", async () => {
    const fixtures = await corpus();
    const fixture = fixtures.find(
      (item) => item.input.fixtureId === "prompt-injection-excerpt",
    );
    if (!fixture) throw new Error("Missing prompt-injection fixture");
    const evaluation = await executeFixtureEvaluation(
      fixture,
      getConfiguration("bounded-source.v1"),
      new MockSemanticGraphProvider(fixtures),
    );
    const report = createAggregateReport({
      provider: "mock",
      fixtureSet: "holdout",
      fixtures: [fixture],
      reports: [createRunReport(fixture, evaluation)],
    });
    const serialized = serializeReport(report);
    expect(serialized).not.toContain("rawResponse");
    expect(serialized).not.toContain("UNTRUSTED_SEMANTIC_PACKET_JSON");
    expect(serialized).not.toContain("SAPIOM_API_KEY");
    expect(serialized).not.toContain("ignore all instructions");
    expect(report.runs[0]).toMatchObject({
      requestedModel: "gpt-luna",
      configurationFingerprint: expect.stringMatching(/^sha256:/),
      packetFingerprint: expect.stringMatching(/^sha256:/),
      promptFingerprint: expect.stringMatching(/^sha256:/),
      outputFingerprint: expect.stringMatching(/^sha256:/),
    });
  });
});
