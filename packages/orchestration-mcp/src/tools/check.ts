/**
 * check tool — local bundle + manifest + graph validation.
 * No network required; validates the orchestration before deploying.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { check, OrchestrationError } from "@sapiom/orchestration-core";

export function register(server: McpServer): void {
  server.tool(
    "orchestration_check",
    "Validate an orchestration project locally: bundles index.ts with esbuild, " +
      "loads the definition, parses the manifest, and checks the step graph. " +
      "Run this before deploying to catch structural errors offline.",
    {
      sourceDir: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the orchestration project directory containing index.ts.",
        ),
    },
    async ({ sourceDir }) => {
      try {
        const result = await check({ sourceDir });

        const warnings =
          result.warnings.length > 0
            ? `\nWarnings:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`
            : "";

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Orchestration validation passed.`,
                ``,
                `Name: ${result.name}`,
                `Steps: ${result.stepCount}`,
                warnings,
              ]
                .filter(Boolean)
                .join("\n"),
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
          content: [
            {
              type: "text" as const,
              text: `check failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
