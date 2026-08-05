import { packageVersion } from "./version.js";

/** Metadata returned by the MCP initialize handshake. */
export function createServerInfo() {
  return {
    name: "sapiom-dev",
    title: "Sapiom Dev — local developer tools",
    description:
      "Sapiom Project MCP (sapiom_dev_*). It scaffolds and tests agents locally, then links, deploys, and operates them through explicit authenticated cloud actions. Distinct from Sapiom Cloud MCP.",
    version: packageVersion(),
  } as const;
}
