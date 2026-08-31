import type { ProviderAttempt } from "../contracts.js";
import { validateProviderAttempt } from "../validation.js";
import { corpus, fixtureById, requestFor } from "./test-helpers.js";

function success(rawResponse: unknown): ProviderAttempt {
  return {
    status: "success",
    rawResponse,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      latencyMs: 1,
      servedClass: "mock",
      lane: "deterministic",
    },
    requestedModel: "gpt-luna",
  };
}

function candidate(overrides: Record<string, unknown> = {}): unknown {
  return {
    relationship: "feeds",
    sourceAgentId: "beta",
    targetAgentId: "gamma",
    explanation: "Gamma consumes Beta output.",
    supportRefs: ["fact:beta:responsibility", "fact:gamma:responsibility"],
    ...overrides,
  };
}

describe("deterministic candidate validation", () => {
  it.each([
    ["invokes", candidate({ relationship: "invokes" }), "invalid-candidate"],
    [
      "unknown endpoint",
      candidate({ targetAgentId: "ghost-agent" }),
      "unknown-endpoint",
    ],
    ["self link", candidate({ targetAgentId: "beta" }), "self-link"],
    [
      "fabricated ref",
      candidate({ supportRefs: ["fact:does-not-exist"] }),
      "fabricated-support-ref",
    ],
    [
      "duplicate support ref",
      candidate({
        supportRefs: ["fact:beta:responsibility", "fact:beta:responsibility"],
      }),
      "fabricated-support-ref",
    ],
    ["unknown field", candidate({ confidence: 0.99 }), "invalid-candidate"],
    [
      "unbounded explanation",
      candidate({ explanation: "x".repeat(501) }),
      "invalid-candidate",
    ],
  ])("quarantines %s", async (_name, rawCandidate, expectedCode) => {
    const fixture = fixtureById(await corpus(), "adversarial-validation");
    const snapshot = validateProviderAttempt(
      requestFor(fixture),
      success({ outcome: "complete", candidates: [rawCandidate] }),
    );
    expect(snapshot.accepted).toEqual([]);
    expect(snapshot.rejected.map((item) => item.code)).toEqual([expectedCode]);
  });

  it("rejects an already-proven feed and only the later duplicate pair", async () => {
    const fixture = fixtureById(await corpus(), "adversarial-validation");
    const request = requestFor(fixture);
    const alreadyProven = candidate({
      sourceAgentId: "alpha",
      targetAgentId: "beta",
      supportRefs: ["fact:alpha:responsibility"],
    });
    const valid = candidate();
    const snapshot = validateProviderAttempt(
      request,
      success({
        outcome: "partial",
        candidates: [alreadyProven, valid, valid],
      }),
    );
    expect(snapshot.accepted).toHaveLength(1);
    expect(snapshot.rejected.map((item) => item.code)).toEqual([
      "already-proven",
      "duplicate-candidate",
    ]);
  });

  it("does not let a quarantined candidate poison a later valid pair", async () => {
    const fixture = fixtureById(await corpus(), "adversarial-validation");
    const snapshot = validateProviderAttempt(
      requestFor(fixture),
      success({
        outcome: "partial",
        candidates: [
          candidate({ supportRefs: ["fact:does-not-exist"] }),
          candidate(),
        ],
      }),
    );
    expect(snapshot.accepted).toHaveLength(1);
    expect(snapshot.rejected.map((item) => item.code)).toEqual([
      "fabricated-support-ref",
    ]);
  });

  it("rejects malformed envelopes and illegal abstention combinations", async () => {
    const fixture = fixtureById(await corpus(), "adversarial-validation");
    const request = requestFor(fixture);
    const unknownField = validateProviderAttempt(
      request,
      success({ outcome: "complete", candidates: [], extra: true }),
    );
    expect(unknownField.attemptStatus).toBe("malformed");
    expect(unknownField.rejected[0].code).toBe("malformed-output");

    const illegalAbstention = validateProviderAttempt(
      request,
      success({ outcome: "abstained", candidates: [candidate()] }),
    );
    expect(illegalAbstention.attemptStatus).toBe("malformed");
    expect(illegalAbstention.rejected[0].code).toBe(
      "abstained-with-candidates",
    );
  });

  it("accepts valid complete abstention and does not blanket-reject cycles", async () => {
    const fixtures = await corpus();
    const abstentionFixture = fixtureById(fixtures, "complete-abstention");
    const abstention = validateProviderAttempt(
      requestFor(abstentionFixture),
      success({ outcome: "abstained", candidates: [] }),
    );
    expect(abstention).toMatchObject({
      attemptStatus: "accepted",
      outcome: "abstained",
      accepted: [],
      rejected: [],
    });

    const fixture = fixtureById(fixtures, "adversarial-validation");
    const cycle = validateProviderAttempt(
      requestFor(fixture),
      success({
        outcome: "complete",
        candidates: [
          candidate(),
          candidate({
            sourceAgentId: "gamma",
            targetAgentId: "beta",
          }),
        ],
      }),
    );
    expect(
      cycle.accepted.map((item) => [item.sourceAgentId, item.targetAgentId]),
    ).toEqual([
      ["beta", "gamma"],
      ["gamma", "beta"],
    ]);
  });

  it("records provider failure without constructing any candidate", async () => {
    const fixture = fixtureById(await corpus(), "complete-abstention");
    const snapshot = validateProviderAttempt(requestFor(fixture), {
      status: "failure",
      errorCode: "http-429",
      latencyMs: 12,
      requestedModel: "gpt-luna",
    });
    expect(snapshot).toMatchObject({
      attemptStatus: "provider-failure",
      providerErrorCode: "http-429",
      outcome: "failed",
      accepted: [],
      rejected: [],
    });
  });
});
