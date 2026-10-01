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
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // Drop the previous subject's link immediately: switching agents must not
    // show agent A's App Link on agent B's bar while B's read is in flight.
    setUrl(null);
    if (!workflowPath || definitionId === null || definitionId === undefined) {
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
  }, [workflowPath, definitionId, deploymentState]);

  return url;
}
