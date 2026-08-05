/**
 * Canonical client-configured names for Sapiom's two MCP connections.
 *
 * These are aliases in a client's config, not MCP `serverInfo.name` values.
 * The local package continues to report `sapiom-dev` on the wire and its tools
 * continue to use the `sapiom_dev_*` namespace.
 */
export const PROJECT_MCP_ALIAS = "sapiom-project";
export const CLOUD_MCP_ALIAS = "sapiom-cloud";
