import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HARNESS_PATHS } from "../../shared/types.js";
import { expandHome } from "../../cli/paths.js";

export interface McpConfigOptions {
  /** SAPIOM_ENVIRONMENT to pass through to the sapiom-dev child process. */
  environment?: string;
  /**
   * Cached Sapiom API key (from CLI auth), if signed in. Sent as
   * `x-api-key` on the remote `sapiom` MCP — empirically verified against
   * api.sapiom.ai/v1/mcp (both `x-api-key` and `Authorization: Bearer` are
   * accepted for `sk_`-prefixed keys; `x-api-key` matches its CORS
   * allow-list order and needs no prefix formatting). Omitted entirely when
   * absent (`--no-auth`, or not yet signed in) — every remote tool call
   * then 401s, same as today.
   */
  apiKey?: string | null;
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
        ...(options.apiKey ? { headers: { "x-api-key": options.apiKey } } : {}),
      },
      "sapiom-dev": {
        command: "npx",
        args: ["-y", "@sapiom/mcp"],
        ...(devEnv ? { env: devEnv } : {}),
      },
    },
  };

  const filePath = path.join(dir, "mcp-config.json");
  // May now carry a live API key (the `sapiom` entry's headers) — restrict
  // to the owner, matching how ~/.sapiom/credentials.json is written.
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return filePath;
}
