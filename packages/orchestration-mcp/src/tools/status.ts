/**
 * status tool — fetch the current state and step records for a single execution.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { inspect, OrchestrationError } from "@sapiom/orchestration-core";
import { makeClient } from "../config.js";

export function register(server: McpServer): void {
  server.tool(
    "orchestration_status",
    "Fetch the current status and step records for a running or completed execution. " +
      "Returns the execution status, the current step (if running), any error, " +
      "and a per-step breakdown.",
    {
      executionId: z
        .string()
        .min(1)
        .describe("Execution ID returned by orchestration_run."),
    },
    async ({ executionId }) => {
      try {
        const client = makeClient();
        const result = await inspect({ executionId }, client);
        const { execution } = result;

        const stepLines =
          execution.steps && execution.steps.length > 0
            ? [
                ``,
                `Steps:`,
                ...execution.steps.map(
                  (s) =>
                    `  [${s.status}] ${s.stepName}` +
                    (s.attempt > 1 ? ` (attempt ${s.attempt})` : "") +
                    (s.error?.message ? ` — ${s.error.message}` : ""),
                ),
              ]
            : [];

        const errorLine =
          execution.error != null
            ? [
                ``,
                `Error: ${typeof execution.error === "object" ? JSON.stringify(execution.error) : execution.error}`,
              ]
            : [];

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Execution ID: ${execution.id}`,
                `Status:       ${execution.status}`,
                execution.currentStep
                  ? `Current step: ${execution.currentStep}`
                  : null,
                ...errorLine,
                ...stepLines,
              ]
                .filter((l) => l !== null)
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
              text: `status failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
