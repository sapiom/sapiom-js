import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MAP_WORKSPACE_SCHEMA_VERSION } from "@sapiom/agent-map";
import {
  McpCapabilitiesSchema,
  type McpCapabilities,
} from "@sapiom/agent-map/host-protocol";
import { packageVersion } from "./version.js";

/** Identity of this package's metadata and executable JS, independent of location.
 * This detects replaced builds; it is not a signature or a dependency-tree lock.
 */
async function artifactHash(): Promise<string> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hash = createHash("sha256");
  const visit = async (relative: string): Promise<void> => {
    for (const entry of (
      await readdir(join(root, relative), { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.endsWith(".js")) {
        hash
          .update(child)
          .update("\0")
          .update(await readFile(join(root, child)))
          .update("\0");
      }
    }
  };
  hash.update(await readFile(join(root, "package.json"))).update("\0");
  await visit("dist");
  return hash.digest("hex");
}

export async function describeCapabilities(): Promise<McpCapabilities> {
  return McpCapabilitiesSchema.parse({
    descriptorVersion: 1,
    packageName: "@sapiom/mcp",
    packageVersion: packageVersion(),
    artifactHash: await artifactHash(),
    hostProtocolVersions: [1],
    mapSchemaVersions: [AGENT_MAP_WORKSPACE_SCHEMA_VERSION],
    features: ["studio-context"],
  });
}
