/**
 * The Sapiom dashboard — one source of truth for every deep-link the SPA opens
 * (the session bar's Prod globe, the rail's account menu, the canvas header's
 * deployed pill). Kept here, not per-component, so a host/domain change
 * (staging, rebrand) is a single edit rather than a hunt for a string that had
 * drifted into three files under three names.
 */
export const SAPIOM_DASHBOARD_ROOT = "https://app.sapiom.ai";

/** The agents index — the account's deployed agents. */
export const SAPIOM_AGENTS_URL = `${SAPIOM_DASHBOARD_ROOT}/agents`;

/** A deployed agent's own page, by its Sapiom definition id. */
export function agentUrl(definitionId: number): string {
  return `${SAPIOM_AGENTS_URL}/${definitionId}`;
}

/** Documentation home — a different host from the dashboard, kept here for the
 *  same reason: the one place a docs/domain change is made. */
export const SAPIOM_DOCS_URL = "https://docs.sapiom.ai";

/** The quick-start the Overview and first-run composer both point newcomers at. */
export const SAPIOM_QUICKSTART_URL = `${SAPIOM_DOCS_URL}/agents/quick-start`;
