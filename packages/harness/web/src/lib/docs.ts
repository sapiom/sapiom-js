/**
 * The documentation the finder can reach.
 *
 * Empty for now. The list held the AI models page, the agents and workflows
 * quick starts and the two halves of MCP setup until docs.sapiom.ai moved to
 * the Sapiom Pay docs (2026-10-23) and those pages were retired. The footer
 * link still opens the docs site, so the Docs tab keeps a way out.
 */
export const DOCS_SITE = "https://docs.sapiom.ai/";

export interface DocLink {
  /** Page title as the docs site names it. */
  label: string;
  /** The one line that says who the page is for. */
  meta: string;
  href: string;
}

export const DOC_LINKS: readonly DocLink[] = [];
