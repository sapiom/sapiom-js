/** Reviewed transport compatibility. Clients still default to legacy delivery; Core admission is separately gated. */
const ELIGIBLE_CAPABILITIES: ReadonlySet<string> = new Set([
  "web.search",
  "web.scrape",
  "email.find",
  "email.verify",
  "email.domain.search",
  "content.generation.images",
  "content.generation.video",
  "memory.append",
  "memory.recall",
  "memory.forget",
  "memory.drop",
  "database.create",
  "domains.purchase",
  "storage.put",
]);
export function executionDeliveryEligible(capabilityId: string): boolean {
  return ELIGIBLE_CAPABILITIES.has(capabilityId);
}
