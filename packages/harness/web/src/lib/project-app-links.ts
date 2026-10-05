/**
 * A project's App Links (flow-map-chat-overlay.md 4.7.3), merged: deployed
 * links (an agent's live durable App Link) first, then local ones (a dev
 * server a live session of the project started), by port. A local link whose
 * URL a deployed link already names is dropped, so one app is never listed
 * twice; a port is listed once however many sessions announced it.
 */
import type { WorkflowInfo } from "@shared/types";

import { displayAgentName } from "./agent-name";

export interface ProjectAppLink {
  /** Unique within the project: `agent-<name>` (`-2`, `-3` for a repeated
   *  name) or `local-<port>`. */
  id: string;
  label: string;
  url: string;
  deployed: boolean;
  /** `localhost:5174`, for a local link: what tells it apart at a glance. */
  host: string | null;
}

/** A detected dev server: `previewBySession`'s value. */
export interface LocalPreview {
  port: number;
  url: string;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Deployed links first (agent order), then local ones by port. */
export function mergeProjectAppLinks(
  deployed: ReadonlyArray<{ agent: WorkflowInfo; url: string }>,
  previews: readonly LocalPreview[],
): ProjectAppLink[] {
  // Names are not unique across a project's agents: a repeat name gets a
  // numbered id, so ids (React keys and test ids) stay one per link.
  const named = new Map<string, number>();
  const links: ProjectAppLink[] = deployed.map(({ agent, url }) => {
    const seen = (named.get(agent.name) ?? 0) + 1;
    named.set(agent.name, seen);
    return {
      id: seen === 1 ? `agent-${agent.name}` : `agent-${agent.name}-${seen}`,
      label: displayAgentName(agent.name),
      url,
      deployed: true,
      host: null,
    };
  });
  const ports = new Set<number>();
  for (const preview of [...previews].sort((a, b) => a.port - b.port)) {
    if (ports.has(preview.port)) continue;
    if (links.some((link) => sameUrl(link.url, preview.url))) continue;
    ports.add(preview.port);
    links.push({
      id: `local-${preview.port}`,
      label: "Dev server",
      url: preview.url,
      deployed: false,
      host: `localhost:${preview.port}`,
    });
  }
  return links;
}
