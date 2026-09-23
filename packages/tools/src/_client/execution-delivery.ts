/** Family adoption populates this reviewed allow-list. Production eligibility stays empty. */
const ELIGIBLE_CAPABILITIES: ReadonlySet<string> = new Set();
export function executionDeliveryEligible(capabilityId: string): boolean {
  return ELIGIBLE_CAPABILITIES.has(capabilityId);
}
