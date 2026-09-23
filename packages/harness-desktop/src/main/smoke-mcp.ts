import { createRequire } from "node:module";
import { mcpCommandForEntry, qualifyMcpCommand } from "@sapiom/harness";

/** Exercise the packaged runtime + unpacked dependency, without npm or a host
 * credential. This supplements the private-map HTTP smoke, whose agent is a stub.
 */
export async function checkMcpCapabilities(): Promise<string> {
  const require = createRequire(import.meta.url);
  const fromHarness = createRequire(
    require.resolve("@sapiom/harness/package.json"),
  );
  const command = mcpCommandForEntry(fromHarness.resolve("@sapiom/mcp"));
  const result = await qualifyMcpCommand(command);
  if (result.kind !== "verified")
    throw new Error(`Packaged MCP preflight: ${result.kind}`);
  if (
    result.launch.command !== process.execPath ||
    result.launch.env?.ELECTRON_RUN_AS_NODE !== "1"
  )
    throw new Error("MCP did not use the packaged Node runtime");
  if (
    result.descriptor.features.some((feature) => feature !== "studio-context")
  )
    throw new Error("Unexpected map feature activation");
  return `MCP ${result.descriptor.packageVersion}: offline context protocol verified, shared maps inactive`;
}
