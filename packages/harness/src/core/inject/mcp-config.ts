import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HARNESS_PATHS } from "../../shared/types.js";
import { expandHome } from "../../cli/paths.js";

export interface McpConfigOptions {
  /** SAPIOM_ENVIRONMENT to pass through to the sapiom-dev child process. */
  environment?: string;
}

/**
 * Writes the `--mcp-config` file for a harness session: the remote HTTP
 * capability MCP (`sapiom`) and the local stdio authoring MCP (`sapiom-dev`).
 * Written under `HARNESS_PATHS.generated/<harnessSessionId>/` so concurrent
 * sessions never share (or race on) a config file. Returns the file's
 * absolute path for the adapter to pass as `--mcp-config <path>`.
 */
export async function generateMcpConfig(
  harnessSessionId: string,
  options: McpConfigOptions = {},
): Promise<string> {
  const dir = path.join(expandHome(HARNESS_PATHS.generated), harnessSessionId);
  await fs.mkdir(dir, { recursive: true });

  const sapiomEnvironment = options.environment ?? process.env.SAPIOM_ENVIRONMENT;
  const devEnv: Record<string, string> | undefined = sapiomEnvironment
    ? { SAPIOM_ENVIRONMENT: sapiomEnvironment }
    : undefined;

  const config = {
    mcpServers: {
      sapiom: {
        type: "http",
        url: "https://api.sapiom.ai/v1/mcp",
      },
      "sapiom-dev": {
        command: "npx",
        args: ["-y", "@sapiom/mcp"],
        ...(devEnv ? { env: devEnv } : {}),
      },
    },
  };

  const filePath = path.join(dir, "mcp-config.json");
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n");
  return filePath;
}
