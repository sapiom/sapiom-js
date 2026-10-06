import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentOperationError } from "@sapiom/agent-core";

import type { ResolvedEnvironment } from "../credentials.js";
import { accountPlatform, buildMap, describeProject, MapInputError } from "../map/index.js";
import { registerTool } from "../register-tool.js";
import { fail, gatewayClient, ok } from "./shared.js";

export { accountPlatform };

const evidenceSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  text: z.string(),
  step: z.string().optional(),
});

const agentSchema = z
  .object({
    slug: z.string().min(1),
    path: z.string().optional(),
    description: z.string().optional(),
    deployed: z.boolean().nullable().optional(),
    steps: z
      .object({
        entry: z.string(),
        steps: z.array(z.object({ id: z.string(), file: z.string().optional(), line: z.number().int().optional() })),
        transitions: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })),
      })
      .optional(),
    calls: z
      .array(
        z.object({
          to: z.string().min(1),
          kind: z.enum(["launch", "signal", "timer"]),
          evidence: z.array(evidenceSchema).optional(),
        }),
      )
      .optional(),
    emits: z.array(z.object({ eventType: z.string().min(1), evidence: z.array(evidenceSchema).optional() })).optional(),
    triggers: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("event"),
            eventType: z.string().min(1),
            source: z.enum(["code", "platform"]).default("code"),
            evidence: z.array(evidenceSchema).optional(),
          }),
          z.object({
            kind: z.literal("schedule"),
            cron: z.string().optional(),
            source: z.enum(["code", "platform"]).default("code"),
            evidence: z.array(evidenceSchema).optional(),
          }),
        ]),
      )
      .optional(),
    resources: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function register(server: McpServer, env: ResolvedEnvironment): void {
  registerTool(
    server,
    "sapiom_dev_map",
    "The agent map: which agents call, launch, schedule or trigger each other, grouped into systems, with every agent's steps. Computed from code each call; nothing is stored. Pass `root` (a project folder; default the working directory) and optionally a git `ref` to draw that version, or pass `agents` to map your own description without scanning. Systems are connected components over code-proven calls, events, signals and timers; shared vault keys, databases and connectors show as `shared` chips and never join agents. Every edge carries the code location that proves it; calls whose target the code does not make knowable are listed under `unresolved`. When signed in, platform triggers and deploy state come from the account (set `platform: false` to skip).",
    {
      root: z.string().optional().describe("Project folder to scan. Default: the working directory."),
      ref: z
        .string()
        .optional()
        .describe("A git ref (HEAD, a branch, a commit) to draw instead of the working copy. Only inside a git repository."),
      agents: z
        .array(agentSchema)
        .optional()
        .describe("Map this description instead of scanning: [{ slug, calls?: [{ to, kind }], emits?, triggers?, steps?, resources? }]."),
      platform: z
        .boolean()
        .optional()
        .describe("Read triggers and deploy state from the signed-in account (default true)."),
    },
    async ({ root, ref, agents, platform }) => {
      try {
        if (agents && (root !== undefined || ref !== undefined)) {
          throw new AgentOperationError({
            code: "INVALID_INPUT",
            message: "Pass either `agents` or `root` (with optional `ref`), not both.",
          });
        }
        if (agents) {
          return ok(buildMap({ root: null, agents, platform: "skipped" }));
        }
        const client = platform === false ? undefined : await gatewayClient(env);
        const description = await describeProject({
          root: root ?? process.cwd(),
          ref,
          platform: platform === false ? undefined : client ? accountPlatform(client) : null,
        });
        return ok(buildMap(description));
      } catch (error) {
        if (error instanceof MapInputError) {
          return fail(new AgentOperationError({ code: error.code, message: error.message }));
        }
        return fail(error);
      }
    },
  );
}
