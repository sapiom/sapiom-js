import type {
  LoadedFixture,
  ProviderAttempt,
  ProviderRequest,
} from "../contracts.js";
import { canonicalJson } from "../fingerprint.js";
import {
  REQUESTED_MODEL,
  providerRunIdentity,
  type SemanticGraphProvider,
} from "../provider.js";

function cloneJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

export class MockSemanticGraphProvider implements SemanticGraphProvider {
  readonly id = "mock" as const;
  private readonly fixtures: Map<string, LoadedFixture>;
  private readonly calls = new Map<string, number>();

  constructor(fixtures: LoadedFixture[]) {
    this.fixtures = new Map(
      fixtures.map((fixture) => [fixture.input.fixtureId, fixture]),
    );
  }

  async invoke(request: ProviderRequest): Promise<ProviderAttempt> {
    const identity = providerRunIdentity(request);
    this.calls.set(identity, (this.calls.get(identity) ?? 0) + 1);
    const fixture = this.fixtures.get(request.fixtureId);
    if (!fixture) {
      throw new TypeError(`No mock response for fixture ${request.fixtureId}`);
    }
    if (fixture.inputFingerprint !== request.inputFingerprint) {
      throw new TypeError(
        `Mock input fingerprint mismatch for ${request.fixtureId}`,
      );
    }
    const response =
      fixture.providerFixture.responses[request.configuration.id];
    if (!response) {
      throw new TypeError(
        `No mock response for ${request.fixtureId}/${request.configuration.id}`,
      );
    }
    if (response.status === "failure") {
      return {
        status: "failure",
        errorCode: response.errorCode,
        latencyMs: response.latencyMs,
        requestedModel: REQUESTED_MODEL,
      };
    }
    return {
      status: "success",
      rawResponse: cloneJson(response.rawResponse),
      usage: { ...response.usage },
      requestedModel: REQUESTED_MODEL,
    };
  }

  invocationCount(request: ProviderRequest): number {
    return this.calls.get(providerRunIdentity(request)) ?? 0;
  }

  get totalInvocationCount(): number {
    return [...this.calls.values()].reduce((total, count) => total + count, 0);
  }

  get invocationCounts(): ReadonlyMap<string, number> {
    return new Map(this.calls);
  }
}
