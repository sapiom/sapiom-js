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
    label: "Agents quick start",
    meta: "Run your first agent",
    href: "https://docs.sapiom.ai/agents/quick-start",
  },
  {
    label: "Workflows quick start",
    meta: "Typed steps, gates and exits",
    href: "https://docs.sapiom.ai/workflows/quick-start",
  },
  {
    label: "AI models",
    meta: "Which models a capability can call",
    href: "https://docs.sapiom.ai/capabilities/ai-models",
  },
  {
    label: "MCP servers: setup",
    meta: "Connect a server to a workspace",
    href: "https://docs.sapiom.ai/integration/mcp-servers/setup",
  },
  {
    label: "MCP servers: remote",
    meta: "Reach a server you do not host",
    href: "https://docs.sapiom.ai/integration/mcp-servers/remote",
  },
];
