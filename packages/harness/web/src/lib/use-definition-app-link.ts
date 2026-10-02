/**
 * The durable App Link for the agent the session bar is about (SAP-3255):
 * `GET /api/workflows/:id/app-link`, re-read when the subject changes and when
 * its deployment state moves.
 *
 * Returns the URL only when core says the link is `live`, and null otherwise:
 * loading, errors, unlinked, unpublished, and no link at all. The chip's
 * contract is to render nothing in every one of those, so the bar of an agent
 * without an App Link is exactly the bar it had before this existed.
 *
 * Why `authenticated` is a key: signing in while the bar is mounted must show
 * a link the signed-out read could not see, and signing out must drop it —
 * the same refetch key useAccountPlan uses.
 *
 * Why the deployment state is a key: a deploy is when a template's `app` build
 * stage publishes the dashboard, so the link can appear without the subject's
 * path or definition id changing.
 */
import { useEffect, useState } from "react";

import { createApi } from "./api";

const api = createApi();

export function useDefinitionAppLink(
  workflowPath: string | null,
  definitionId: number | string | null | undefined,
  deploymentState: string,
  authenticated: boolean,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // Drop the previous subject's link immediately: switching agents must not
    // show agent A's App Link on agent B's bar while B's read is in flight.
    setUrl(null);
    // Signed out, the server could only answer "no App Link"; skip the read.
    if (
      !authenticated ||
      !workflowPath ||
      definitionId === null ||
      definitionId === undefined
    ) {
      return;
    }
    let cancelled = false;
    api.getAppLink(workflowPath).then(
      (view) => {
        if (!cancelled) setUrl(view.status === "live" ? view.url : null);
      },
      () => {
        if (!cancelled) setUrl(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workflowPath, definitionId, deploymentState, authenticated]);

  return url;
}
