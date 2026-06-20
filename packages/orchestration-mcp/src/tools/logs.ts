/**
 * logs tool — list recent executions or inspect a build run.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  listExecutions,
  inspectBuild,
  OrchestrationError,
} from "@sapiom/orchestration-core";
import { makeClient } from "../config.js";

export function register(server: McpServer): void {
  // List recent executions
  server.tool(
    "orchestration_logs",
    "List recent executions across all definitions for the authenticated tenant. " +
      "Returns execution IDs, statuses, and the current step for in-progress runs. " +
      "Use orchestration_status for detailed step records on a single execution.",
    {},
    async () => {
      try {
        const client = makeClient();
        const result = await listExecutions(client);

        if (result.executions.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No executions found for this definition.",
              },
            ],
          };
        }

        const lines = result.executions.map(
          (e) =>
            `  ${e.id}  [${e.status}]${e.currentStep ? `  step: ${e.currentStep}` : ""}`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Recent executions (${result.executions.length}):`,
                ...lines,
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
              text: `logs failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Inspect a build run
  server.tool(
    "orchestration_build_status",
    "Fetch the status of a specific build run. " +
      "Useful for checking why a deploy failed.",
    {
      definitionId: z
        .string()
        .min(1)
        .describe("Server-side definition ID the build belongs to."),
      buildRunId: z
        .string()
        .min(1)
        .describe("Build run ID returned by orchestration_deploy."),
    },
    async ({ definitionId, buildRunId }) => {
      try {
        const client = makeClient();
        const result = await inspectBuild({ definitionId, buildRunId }, client);
        const { build } = result;

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Build run ID: ${build.id ?? buildRunId}`,
                `Status:       ${build.status}`,
                build.error != null
                  ? `Error:        ${typeof build.error === "object" ? JSON.stringify(build.error) : build.error}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          isError: build.status === "failed" ? true : undefined,
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
              text: `build_status failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
