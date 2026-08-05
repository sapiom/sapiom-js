/**
 * Build the canonical webapp URL for one agent run, so run-returning tools can
 * hand the caller a link to open instead of leaving the model to guess a route
 * (it guessed a non-existent `/agents/<id>/executions/<id>` before this existed).
 *
 * The origin comes from the resolved environment's `appURL`
 * (https://app.sapiom.ai in prod, https://app.sapiom.dev in staging,
 * http://localhost:2999 locally). The path mirrors the frontend's `runHref`
 * (`/agents/<definitionId>/runs/<runId>`); when a run predates definition
 * linkage and has no `definitionId`, fall back to the id-only resolver route
 * (`/agents/runs/<runId>`), which the webapp resolves to the owning definition.
 */
export function webappRunUrl(
  appURL: string,
  definitionId: string | null | undefined,
  runId: string,
): string {
  const path = definitionId
    ? `/agents/${encodeURIComponent(definitionId)}/runs/${encodeURIComponent(runId)}`
    : `/agents/runs/${encodeURIComponent(runId)}`;
  // `new URL(path, appURL)` joins the origin robustly whether or not `appURL`
  // carries a trailing slash, matching the backend's link-building idiom.
  return new URL(path, appURL).toString();
}
