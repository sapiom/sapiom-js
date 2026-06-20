/**
 * deploy tool — push the current commit, trigger a server-side build, and poll
 * until the build reaches a terminal state.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  deploy,
  readConfig,
  OrchestrationError,
} from "@sapiom/orchestration-core";
import { makeClient } from "../config.js";

export function register(server: McpServer): void {
  server.tool(
    "orchestration_deploy",
    "Deploy an orchestration project to the server. Pushes the current git commit, " +
      "triggers a server-side build, and polls until the build completes. " +
      "The project must be a git repository and linked to a server-side definition " +
      "(sapiom.json must contain a definitionId). " +
      "Run orchestration_check first to validate locally.",
    {
      projectDir: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the orchestration project directory. " +
            "Must contain sapiom.json with a definitionId.",
        ),
      branch: z
        .string()
        .optional()
        .describe("Git branch to push to. Defaults to 'main'."),
    },
    async ({ projectDir, branch }) => {
      try {
        const cfg = readConfig(projectDir);
        if (!cfg?.definitionId) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "This project is not linked to a server-side orchestration. " +
                  "Run orchestration_link to link it first.",
              },
            ],
            isError: true,
          };
        }

        const client = makeClient(projectDir);
        const result = await deploy(
          { projectDir, definitionId: cfg.definitionId, branch },
          client,
        );

        const statusLine =
          result.status === "ready"
            ? "Build completed successfully."
            : `Build finished with status: ${result.status}`;

        return {
          content: [
            {
              type: "text" as const,
              text: [
                statusLine,
                ``,
                `Definition ID: ${result.definitionId}`,
                `Build run ID:  ${result.buildRunId}`,
                `Status:        ${result.status}`,
              ].join("\n"),
            },
          ],
          isError: result.status !== "ready",
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
              text: `deploy failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
