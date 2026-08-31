import { getConfiguration } from "../configurations.js";
import { executeFixtureEvaluation, scoreSnapshot } from "../evaluate.js";
import { canonicalJson } from "../fingerprint.js";
import { MockSemanticGraphProvider } from "../providers/mock.js";
import { validateProviderAttempt } from "../validation.js";
import { corpus, fixtureById, requestFor } from "./test-helpers.js";

describe("oracle scoring", () => {
  it("computes directed TP, FP, FN, precision, recall, and F1", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "unsupported-cycle");
    const evaluation = await executeFixtureEvaluation(
      fixture,
      getConfiguration("context-pressure.v1"),
      new MockSemanticGraphProvider(fixtures),
    );
    expect(evaluation.metrics).toMatchObject({
      truePositives: 0,
      falsePositives: 2,
      falseNegatives: 0,
      precision: 0,
      recall: null,
      f1: null,
      falsePositiveCategories: { "unsupported-cycle": 2 },
    });
  });

  it("handles zero-candidate denominators and correct abstention", async () => {
    const fixture = fixtureById(await corpus(), "complete-abstention");
    const snapshot = validateProviderAttempt(requestFor(fixture), {
      status: "success",
      rawResponse: { outcome: "abstained", candidates: [] },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        servedClass: "mock",
        lane: "deterministic",
      },
      requestedModel: "gpt-luna",
    });
    expect(scoreSnapshot(snapshot, fixture.oracle)).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: null,
      recall: null,
      f1: null,
      correctAbstention: true,
      abstention: "correct",
      falsePositiveCategories: {},
    });
  });

  it("distinguishes incorrect abstention and never mutates validator output", async () => {
    const fixture = fixtureById(await corpus(), "opaque-store-reload");
    const snapshot = validateProviderAttempt(requestFor(fixture), {
      status: "success",
      rawResponse: { outcome: "abstained", candidates: [] },
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: 1,
        servedClass: null,
        lane: null,
      },
      requestedModel: "gpt-luna",
    });
    const before = canonicalJson(snapshot);
    const metrics = scoreSnapshot(snapshot, fixture.oracle);
    expect(metrics).toMatchObject({
      falseNegatives: 1,
      recall: 0,
      abstention: "incorrect",
      correctAbstention: false,
    });
    expect(canonicalJson(snapshot)).toBe(before);
  });

  it("recovers both residual flows in the mixed-project bounded-source case", async () => {
    const fixtures = await corpus();
    const fixture = fixtureById(fixtures, "mixed-project-stress");
    const provider = new MockSemanticGraphProvider(fixtures);
    const evaluation = await executeFixtureEvaluation(
      fixture,
      getConfiguration("bounded-source.v1"),
      provider,
    );
    expect(evaluation.metrics).toMatchObject({
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(provider.totalInvocationCount).toBe(1);
  });
});
