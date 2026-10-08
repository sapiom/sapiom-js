import * as os from "node:os";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentOperationError } from "@sapiom/agent-core";

import { readCredentials, type ResolvedEnvironment } from "../credentials.js";
import {
  accountEvaluate,
  accountPlatform,
  buildMap,
  describeProject,
  fileLabelCache,
  labelMap,
  MapInputError,
  memoryLabelCache,
} from "../map/index.js";
import { registerTool } from "../register-tool.js";
import { fail, gatewayClient, ok } from "./shared.js";

export { accountEvaluate, accountPlatform };


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
        steps: z.array(
          z.object({
            id: z.string(),
            file: z.string().optional(),
            line: z.number().int().optional(),
          }),
        ),
        transitions: z.array(
          z.object({ from: z.string(), to: z.string(), kind: z.string() }),
        ),
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
    emits: z
      .array(
        z.object({
          eventType: z.string().min(1),
          evidence: z.array(evidenceSchema).optional(),
        }),
      )
      .optional(),
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
  // A described map has no folder to keep a cache in; this one lives as long as the server.
  const describedCache = memoryLabelCache();
  registerTool(
    server,
    "sapiom_dev_map",
    "The agent map: which agents call, launch, schedule or trigger each other, grouped into systems, with every agent's steps. Computed from code each call; nothing about agents or edges is stored. Pass `root` (a project folder; default the working directory) and optionally a git `ref` to draw that version, or pass `agents` to map your own description without scanning. Systems are connected components over code-proven calls, events, signals and timers; shared vault keys, databases and connectors show as `shared` chips and never join agents. Every edge carries the code location that proves it; calls whose target the code does not make knowable are listed under `unresolved`. When signed in, platform triggers and deploy state come from the account, and Jev labels an agent's `role` and a launch or event edge's `label` where its probability `p` is at least 0.8 (`labels: \"ok\"`; signed out or Jev unreachable: `labels: \"unavailable\"`, the map otherwise unchanged). Set `platform: false` to skip both.",
    {
      root: z
        .string()
        .optional()
        .describe("Project folder to scan. Default: the working directory."),
      ref: z
        .string()
        .optional()
        .describe(
          "A git ref (HEAD, a branch, a commit) to draw instead of the working copy. Only inside a git repository.",
        ),
      agents: z
        .array(agentSchema)
        .optional()
        .describe(
          "Map this description instead of scanning: [{ slug, calls?: [{ to, kind }], emits?, triggers?, steps?, resources? }].",
        ),
      platform: z
        .boolean()
        .optional()
        .describe(
          "Read triggers and deploy state from the signed-in account and ask Jev for labels (default true).",
        ),
    },
    async ({ root, ref, agents, platform }) => {
      try {
        if (agents && (root !== undefined || ref !== undefined)) {
          throw new AgentOperationError({
            code: "INVALID_INPUT",
            message:
              "Pass either `agents` or `root` (with optional `ref`), not both.",
          });
        }
        const client =
          platform === false ? undefined : await gatewayClient(env);
        const credentials = client ? await readCredentials(env.name) : null;
        // The account and key ids name the cache; the key itself never enters it.
        const cacheKey = credentials
          ? `${env.apiURL}\0${credentials.tenantId}\0${credentials.apiKeyId}`
          : undefined;
        const map = agents
          ? buildMap({ root: null, agents, platform: "skipped" })
          : buildMap(
              await describeProject({
                // Node does not expand `~`; callers (and the README) use it.
                root: root
                  ? root.replace(/^~(?=$|[\\/])/, os.homedir())
                  : process.cwd(),
                ref,
                platform:
                  platform === false
                    ? undefined
                    : client
                      ? accountPlatform(client, { cacheKey })
                      : null,
              }),
            );
        const labelled = await labelMap(map, {
          evaluate: client ? accountEvaluate(client) : undefined,
          cache: map.root ? fileLabelCache(map.root) : describedCache,
        });
        return ok(labelled.map);
      } catch (error) {
        if (error instanceof MapInputError) {
          return fail(
            new AgentOperationError({
              code: error.code,
              message: error.message,
            }),
          );
        }
        return fail(error);
      }
    },
  );
}
