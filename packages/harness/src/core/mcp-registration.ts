/**
 * Canonical client-configured names for Sapiom's two MCP connections.
 *
 * These are aliases in a client's config, not MCP `serverInfo.name` values.
 * The local package continues to report `sapiom-dev` on the wire and its tools
 * continue to use the `sapiom_dev_*` namespace.
 */
export const LOCAL_AUTHORING_MCP_ALIAS = "sapiom";
export const HOSTED_CAPABILITY_MCP_ALIAS = "sapiom-direct";
