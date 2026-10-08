/**
 * A project's App Links, for its header (flow-map-chat-overlay.md 4.7.3): the
 * project's resources, every available one, deployed or local.
 *
 * - Deployed: an agent's durable App Link (SAP-3255), read per linked agent
 *   from `GET /api/workflows/:id/app-link`, shown only when core says `live`.
 * - Local: a dev server a live session of the project started
 *   (`port.detected`), shown as an App Link that is not deployed. This
 *   replaces the per-session Preview chip; there is no Preview chip anywhere.
 */
import { useEffect, useMemo, useState } from "react";
import type { WorkflowInfo } from "@shared/types";

import { createApi } from "./api";
import {
  mergeProjectAppLinks,
  type LocalPreview,
  type ProjectAppLink,
} from "./project-app-links";

export type { LocalPreview, ProjectAppLink };

const api = createApi();

/**
 * The live App Links of `agents` (re-read when the set of linked agents or
 * the sign-in changes), merged with `previews`. Signed out, or for an agent
 * with no definition, there is nothing to read and only local links show.
 */
export function useProjectAppLinks(
  agents: readonly WorkflowInfo[],
  previews: readonly LocalPreview[],
  authenticated: boolean,
): ProjectAppLink[] {
  const linked = agents.filter((agent) => agent.definitionId != null);
  // A string key, so a new agents array with the same linked agents (every
  // state poll) does not refetch.
  const key = linked
    .map(
      (agent) =>
        `${agent.path}\u0000${agent.definitionId}\u0000${agent.activeBuildRunStatus ?? ""}`,
    )
    .join("\u0001");
  const [deployed, setDeployed] = useState<
    Array<{ agent: WorkflowInfo; url: string }>
  >([]);

  useEffect(() => {
    // Drop the last project's links at once: another project's App Link must
    // never sit in this header while this one's reads are in flight.
    setDeployed([]);
    if (!authenticated || linked.length === 0) return;
    let cancelled = false;
    void Promise.all(
      linked.map((agent) =>
        api.getAppLink(agent.path).then(
          (view) =>
            view.status === "live" && view.url ? { agent, url: view.url } : null,
          () => null,
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      setDeployed(
        results.filter(
          (entry): entry is { agent: WorkflowInfo; url: string } => entry != null,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
    // `linked` is read through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, authenticated]);

  return useMemo(
    () => mergeProjectAppLinks(deployed, previews),
    [deployed, previews],
  );
}
