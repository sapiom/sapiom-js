/**
 * signal tool — deliver a named signal to a paused execution.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  signal,
  parseSignalPayload,
  OrchestrationError,
} from "@sapiom/orchestration-core";
import { makeClient } from "../config.js";

export function register(server: McpServer): void {
  server.tool(
    "orchestration_signal",
    "Resume a paused execution by delivering a named signal. " +
      "An orchestration pauses at a 'waitForSignal' step until the matching signal arrives. " +
      "Returns the number of executions that received the signal.",
    {
      executionId: z
        .string()
        .min(1)
        .describe("ID of the execution to signal."),
      name: z
        .string()
        .min(1)
        .describe(
          "Signal name that the orchestration is waiting on (e.g. 'approval', 'payment-confirmed').",
        ),
      correlationId: z
        .string()
        .min(1)
        .describe(
          "Correlation ID used to match the signal to the correct execution branch.",
        ),
      payload: z
        .string()
        .optional()
        .describe(
          "JSON-encoded payload to pass to the orchestration when resuming. " +
            "Omit if the signal carries no data.",
        ),
    },
    async ({ executionId, name, correlationId, payload }) => {
      try {
        const parsedPayload = payload ? parseSignalPayload(payload) : undefined;
        const client = makeClient();
        const result = await signal(
          { executionId, name, correlationId, payload: parsedPayload },
          client,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Signal delivered.`,
                ``,
                `Signal name:    ${name}`,
                `Execution ID:   ${executionId}`,
                `Matched:        ${result.matched} execution(s)`,
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
              text: `signal failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
