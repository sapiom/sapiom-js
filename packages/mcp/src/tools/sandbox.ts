/**
 * Sandbox preview tools. Thin wrappers over @sapiom/sandbox-preview.
 *
 * `sapiom_dev_sandbox_preview` reads the project's `sapiom.json` (`type: "sandbox"`),
 * provisions the sandbox if needed, uploads the local code, and calls the
 * server-side deploy op for a live URL. Results are returned as JSON text so the
 * calling agent can parse them.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { previewSandbox, PreviewOperationError } from "@sapiom/sandbox-preview";

import { readCredentials, type ResolvedEnvironment } from "../credentials.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const structured =
    err instanceof PreviewOperationError
      ? err.toStructured()
      : { code: "UNEXPECTED", message: err instanceof Error ? err.message : String(err) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: structured }, null, 2) }],
    isError: true,
  };
}

const NOT_AUTHED = fail(
  new PreviewOperationError({
    code: "NOT_AUTHENTICATED",
    message: "Not authenticated. Run sapiom_authenticate first.",
  }),
);

export function register(server: McpServer, env: ResolvedEnvironment): void {
  server.tool(
    "sapiom_dev_sandbox_preview",
    "Deploy a web-app preview from the current project to a Sapiom sandbox and get a live URL. " +
      "Reads sapiom.json (a `type: \"sandbox\"` resource), provisions the sandbox if needed, uploads " +
      "the local code, builds, starts, and exposes a public URL. Returns { name, url, status, logs }. " +
      "A `failed` status carries build/start logs (not an error) so you can fix and retry.",
    {
      dir: z.string().optional().describe("Project directory (defaults to the current working directory)."),
      name: z.string().optional().describe("Which sandbox to deploy, when the project defines more than one."),
    },
    async ({ dir, name }) => {
      const creds = await readCredentials(env.name);
      if (!creds) return NOT_AUTHED;
      try {
        const result = await previewSandbox({ dir: dir ?? process.cwd(), name, apiKey: creds.apiKey });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
