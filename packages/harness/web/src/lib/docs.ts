/**
 * The documentation the finder can reach.
 *
 * Five pages, not a mirror of the site's nav: these are the ones someone
 * reaches for from inside the product — how to start an agent, how to start a
 * workflow, which models a capability can call, and the two halves of MCP
 * setup. Everything else is one click away behind the footer link, which is
 * why this list gets to stay short instead of growing a page per release.
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
