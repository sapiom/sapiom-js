/**
 * Helpers for detecting and messaging a "definition not found" failure — the
 * error a Prod Run or Deploy surfaces when the workflow's `sapiom.json` carries
 * a `definitionId` that belongs to a different account (e.g. a gallery template
 * whose committed config pre-linked it to the Sapiom team's own deployment).
 *
 * The raw backend message surfaces as something like:
 *   "Agent definition not found: 266"
 *   "Definition not found."
 *   "definition not found"
 *
 * This module detects that shape and replaces the dead-end toast text with an
 * actionable message that tells the user what to do.
 */

/** Matches messages that indicate the linked definition id isn't on the user's
 *  account. The backend surfaces these as HTTP 404s whose message body contains
 *  "definition not found" (case-insensitive). */
const DEFINITION_NOT_FOUND_RE = /\bdefinition\b.{0,30}\bnot found\b/i;

/**
 * Returns true when the failure message indicates that the workflow's linked
 * `definitionId` was not found on the user's account. This is the signal to
 * replace the raw toast text with an actionable deploy-to-publish message.
 */
export function isDefinitionNotFoundError(message: string): boolean {
  return DEFINITION_NOT_FOUND_RE.test(message);
}

/**
 * Human-readable message to show in place of the raw backend error when a Prod
 * Run or Deploy fails with a definition-not-found. Optionally includes the id
 * that was rejected so the user can look it up.
 */
export function definitionNotFoundMessage(definitionId?: string | number): string {
  const idSuffix = definitionId != null ? ` (id: ${definitionId})` : "";
  return (
    `This workflow is linked to an agent that isn't on your account${idSuffix}. ` +
    `Deploy it first to publish it under your account.`
  );
}
