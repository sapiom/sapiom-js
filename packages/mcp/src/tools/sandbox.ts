/**
 * Sandbox preview tools. Thin wrappers over @sapiom/sandbox-preview.
 *
 * - `sapiom_dev_sandbox_configure` writes a validated `type: "sandbox"` resource
 *   into `sapiom.json` from typed args (config-as-tool-args — the agent fills a
 *   typed schema instead of hand-writing JSON, which it tends to get wrong).
 * - `sapiom_dev_sandbox_check` validates those resources without deploying.
 * - `sapiom_dev_sandbox_preview` reads the project's `sapiom.json` (`type: "sandbox"`),
 *   provisions the sandbox if needed, uploads the local code, and calls the
 *   server-side deploy op for a live URL.
 *
 * Results are returned as JSON text so the calling agent can parse them.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  previewSandbox,
  configureSandbox,
  checkSandboxes,
  sandboxConfigBodySchema,
  PreviewOperationError,
} from "@sapiom/sandbox-preview";

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
    "sapiom_dev_sandbox_configure",
    "Create or update a sandbox preview resource in the project's sapiom.json. Fill the typed " +
      "arguments instead of hand-writing JSON — the config is validated and written under " +
      "resources.<name> (type: \"sandbox\"). Returns the stored config. Use sapiom_dev_sandbox_preview " +
      "afterwards to deploy it.",
    {
      dir: z.string().optional().describe("Project directory (defaults to the current working directory)."),
      name: z
        .string()
        .describe("Resource name — the sapiom.json `resources` key and the sandbox name (e.g. `web`)."),
      ...sandboxConfigBodySchema.shape,
    },
    async ({ dir, name, ...body }) => {
      try {
        const result = configureSandbox(dir ?? process.cwd(), name, body);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "sapiom_dev_sandbox_check",
    "Validate the sandbox preview resources in the project's sapiom.json without deploying. " +
      "Returns { ok, sandboxes, issues }; `issues` lists actionable validation problems to fix " +
      "before previewing.",
    {
      dir: z.string().optional().describe("Project directory (defaults to the current working directory)."),
    },
    async ({ dir }) => {
      try {
        const result = checkSandboxes(dir ?? process.cwd());
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

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
