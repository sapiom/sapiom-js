import type { ProviderAttempt, ProviderRequest } from "./contracts.js";

export const REQUESTED_MODEL = "gpt-luna" as const;

export interface SemanticGraphProvider {
  readonly id: "mock" | "sapiom-luna";
  invoke(request: ProviderRequest): Promise<ProviderAttempt>;
}

export function providerRunIdentity(request: ProviderRequest): string {
  return [
    request.fixtureId,
    request.requestedModel,
    request.inputFingerprint,
    request.packetFingerprint,
    request.promptFingerprint,
    request.configuration.id,
    request.configurationFingerprint,
  ].join("/");
}

export function sanitizeProviderErrorCode(status: number | null): string {
  if (
    status !== null &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 600
  ) {
    return `http-${status}`;
  }
  return "provider-error";
}
