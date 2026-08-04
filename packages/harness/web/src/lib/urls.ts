/**
 * The Sapiom dashboard — one source of truth for every deep-link the SPA opens
 * (the session bar's Prod globe, the rail's account menu, the canvas header's
 * deployed pill). Kept here, not per-component, so a host/domain change
 * (staging, rebrand) is a single edit rather than a hunt for a string that had
 * drifted into three files under three names.
 */
export const SAPIOM_DASHBOARD_ROOT = "https://app.sapiom.ai";

/** The workflows index — the account's agents. */
export const SAPIOM_WORKFLOWS_URL = `${SAPIOM_DASHBOARD_ROOT}/workflows`;

/** A deployed agent's own page, by its Sapiom definition id. */
export function workflowUrl(definitionId: number): string {
  return `${SAPIOM_WORKFLOWS_URL}/${definitionId}`;
}
