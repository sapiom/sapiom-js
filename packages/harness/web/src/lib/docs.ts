/**
 * The documentation the finder can reach.
 *
 * One page, not a mirror of the site's nav: which models a capability can
 * call. The list also held the agents and workflows quick starts and the two
 * halves of MCP setup until those pages were retired (2026-10-23).
 * Everything else is one click away behind the footer link, which is why this
 * list gets to stay short instead of growing a page per release.
 */
export const DOCS_SITE = "https://docs.sapiom.ai/";

export interface DocLink {
  /** Page title as the docs site names it. */
  label: string;
  /** The one line that says who the page is for. */
  meta: string;
  href: string;
}

export const DOC_LINKS: readonly DocLink[] = [
  {
    label: "AI models",
    meta: "Which models a capability can call",
    href: "https://docs.sapiom.ai/capabilities/ai-models",
  },
];
