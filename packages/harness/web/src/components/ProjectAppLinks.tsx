import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import {
  useProjectAppLinks,
  type LocalPreview,
} from "../lib/use-project-app-links";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { Icon } from "./Icon";

/** What the header knows about a project's App Links before reading them. */
export interface ProjectAppLinkSources {
  /** The project's agents; the linked ones are asked for their App Link. */
  agents: readonly WorkflowInfo[];
  /** Dev servers the project's live sessions started (`port.detected`). */
  previews: readonly LocalPreview[];
  authenticated: boolean;
}

/**
 * The project header's App Links (flow-map-chat-overlay.md 4.7.3; mock
 * project-app-links): after the project name and "Agent Map", every App Link
 * of the project. Deployed: Globe and its label, opens its URL. Local: Plug,
 * its label and "localhost:5174 · not deployed". Told apart by icon and word,
 * not colour alone. A narrow header sheds the host text; the tooltip and the
 * accessible name keep it. Nothing renders when the project has none.
 */
export function ProjectAppLinks({
  sources,
}: {
  sources: ProjectAppLinkSources;
}): JSX.Element | null {
  const links = useProjectAppLinks(
    sources.agents,
    sources.previews,
    sources.authenticated,
  );
  if (links.length === 0) return null;
  return (
    <div
      className="project-app-links"
      data-testid="project-app-links"
      role="group"
      aria-label="App Links"
      // A deployed link is labelled with its agent's name: user-named.
      {...trackingAttrs({ object: "agent" })}
    >
      {links.map((link) => {
        const where = link.deployed
          ? link.url
          : `${link.host ?? link.url} · not deployed`;
        return (
          <a
            key={link.id}
            className="project-app-link"
            data-testid={`project-app-link-${link.id}`}
            data-deployed={link.deployed ? "true" : "false"}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${link.label}, ${where}`}
            data-tooltip={`${link.label} · ${where}`}
          >
            <Icon name={link.deployed ? "Globe" : "Plug"} size={12} />
            <span className="project-app-link-label">{link.label}</span>
            {!link.deployed && " "}
            {!link.deployed && (
              <span className="project-app-link-host">
                {link.host ?? link.url} · not deployed
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}
