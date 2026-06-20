/**
 * link tool — resolve or create a server-side orchestration definition and
 * write its ID into the project's sapiom.json.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  link,
  writeConfig,
  readConfig,
  OrchestrationError,
} from "@sapiom/orchestration-core";
import { makeClient } from "../config.js";

export function register(server: McpServer): void {
  server.tool(
    "orchestration_link",
    "Link a local orchestration project to a server-side definition by name. " +
      "Resolves the definition on the server and writes its ID into sapiom.json. " +
      "Pass create=true to provision a new definition when one does not exist yet.",
    {
      projectDir: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the orchestration project directory. " +
            "sapiom.json will be updated with the resolved definitionId.",
        ),
      name: z
        .string()
        .min(1)
        .describe(
          "Name or slug of the server-side orchestration definition to link to.",
        ),
      create: z
        .boolean()
        .optional()
        .describe(
          "When true, create the definition on the server if it does not exist yet. " +
            "Defaults to false.",
        ),
    },
    async ({ projectDir, name, create }) => {
      try {
        const client = makeClient(projectDir);
        const result = await link({ name, create }, client);

        // Persist the resolved id alongside any existing config fields
        const existing = readConfig(projectDir);
        writeConfig(projectDir, {
          ...(existing ?? {}),
          definitionId: result.definitionId,
          name: result.name,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Project linked to server-side definition.`,
                ``,
                `Name:          ${result.name}`,
                `Definition ID: ${result.definitionId}`,
                ``,
                `sapiom.json updated. You can now run orchestration_deploy.`,
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
              text: `link failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
