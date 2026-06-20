/**
 * run tool — start a new execution of a server-side orchestration definition.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  run,
  parseJsonInput,
  readConfig,
  OrchestrationError,
} from "@sapiom/orchestration-core";
import { makeClient } from "../config.js";

export function register(server: McpServer): void {
  server.tool(
    "orchestration_run",
    "Start a new execution of a server-side orchestration definition. " +
      "Returns an executionId that you can poll with orchestration_status.",
    {
      definitionId: z
        .string()
        .optional()
        .describe(
          "Server-side definition ID. " +
            "If omitted, the definitionId is read from sapiom.json in projectDir.",
        ),
      projectDir: z
        .string()
        .optional()
        .describe(
          "Absolute path to the orchestration project directory. " +
            "Used to read definitionId from sapiom.json when definitionId is not provided. " +
            "Also informs host resolution from sapiom.json.",
        ),
      input: z
        .string()
        .optional()
        .describe(
          "JSON-encoded execution input. Omit for orchestrations with no required input.",
        ),
    },
    async ({ definitionId, projectDir, input }) => {
      try {
        let resolvedDefinitionId = definitionId;
        if (!resolvedDefinitionId) {
          const cfg = projectDir ? readConfig(projectDir) : null;
          if (!cfg?.definitionId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "No definitionId provided and none found in sapiom.json. " +
                    "Pass definitionId or projectDir pointing to a linked project.",
                },
              ],
              isError: true,
            };
          }
          resolvedDefinitionId = cfg.definitionId;
        }

        const parsedInput = input ? parseJsonInput(input) : undefined;
        const client = makeClient(projectDir);
        const result = await run(
          { definitionId: resolvedDefinitionId, input: parsedInput },
          client,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Execution started.`,
                ``,
                `Execution ID: ${result.executionId}`,
                ``,
                `Use orchestration_status to check progress.`,
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
          content: [
            {
              type: "text" as const,
              text: `run failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
