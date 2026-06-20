/**
 * scaffold tool — initialize a new orchestration project locally from a
 * bundled template. Pure local operation; no network call required.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  scaffold,
  resolveVersions,
  OrchestrationError,
} from "@sapiom/orchestration-core";

export function register(server: McpServer): void {
  server.tool(
    "orchestration_scaffold",
    "Initialize a new Sapiom orchestration project in a local directory. " +
      "Creates the project skeleton (index.ts, package.json, tsconfig, sapiom.json placeholder) " +
      "from the default template. After scaffolding, open the project directory and write your " +
      "workflow definition, then use orchestration_check to validate it locally before deploying.",
    {
      targetDir: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the directory where the project should be created. " +
            "Must not already contain an index.ts or package.json.",
        ),
      projectName: z
        .string()
        .min(1)
        .describe(
          "Human-readable name for the orchestration (e.g. 'invoice-processor'). " +
            "Stamped into package.json and sapiom.json.",
        ),
      template: z
        .string()
        .optional()
        .describe(
          "Template name to scaffold from. Omit to use the default template.",
        ),
    },
    async ({ targetDir, projectName, template }) => {
      try {
        const versions = await resolveVersions();
        const result = await scaffold({
          targetDir,
          projectName,
          template,
          versions,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Orchestration project scaffolded successfully.`,
                ``,
                `Directory: ${result.targetDir}`,
                `Template: ${result.template}`,
                `Project name: ${result.projectName}`,
                ``,
                `Next steps:`,
                `  1. Open ${result.targetDir}/index.ts and write your workflow definition.`,
                `  2. Run orchestration_check to validate the definition locally.`,
                `  3. Run orchestration_deploy to link and deploy to the server.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof OrchestrationError
            ? `${err.message}${err.hint ? `\nHint: ${err.hint}` : ""}`
            : err instanceof Error
              ? err.message
              : "Unknown error";
        return {
          content: [{ type: "text" as const, text: `scaffold failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
