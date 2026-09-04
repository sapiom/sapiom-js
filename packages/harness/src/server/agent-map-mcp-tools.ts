import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProjectAgentSession } from "../shared/agent-map.js";
import {
  AgentMapProposalConflictError,
  AgentMapProposalProjectError,
  AgentMapProposalQuotaError,
  AgentMapProposalService,
  AgentMapProposalValidationError,
} from "../core/agent-map-proposal-service.js";
import { proposalBatchRequestSchema } from "../core/agent-map-proposal-schema.js";
import { AgentMapWorkspaceStoreError } from "../core/agent-map-workspace-store.js";
import { AgentBriefService, AgentBriefServiceError } from "../core/agent-brief-service.js";
import { BuildPlanService, BuildPlanServiceError } from "../core/build-plan-service.js";
import {
  SubsessionCoordinator,
  SubsessionCoordinatorError,
} from "../core/subsession-coordinator.js";
import {
  agentBriefRefreshRequestSchema,
  buildPlanApplyRequestSchema,
  buildPlanReadToolInputSchema,
  buildPlanRebaseRequestSchema,
} from "../core/build-plan-schema.js";

/**
 * MCP discovery sees the complete SAP-3061 input contract. Field-level `catch`
 * deliberately returns invalid values unchanged at execution time so the
 * proposal service, rather than the SDK's generic InvalidParams path, can
 * translate them into our bounded validation issues and recovery guidance.
 * zod-to-json-schema renders each ZodCatch from its inner schema; the final
 * refinement keeps every envelope field required in the advertised contract.
 */
const preserveInvalidForService = <Schema extends z.ZodTypeAny>(
  schema: Schema,
) =>
  schema
    .catch((context: { input: unknown }) => context.input as z.output<Schema>)
    .refine((value) => value !== undefined);

const batchSchema = z
  .object({
    schemaVersion: preserveInvalidForService(
      proposalBatchRequestSchema.shape.schemaVersion,
    ),
    proposalId: preserveInvalidForService(
      proposalBatchRequestSchema.shape.proposalId,
    ),
    expectedVersion: preserveInvalidForService(
      proposalBatchRequestSchema.shape.expectedVersion,
    ),
    requestId: preserveInvalidForService(
      proposalBatchRequestSchema.shape.requestId,
    ),
    operations: preserveInvalidForService(
      proposalBatchRequestSchema.shape.operations,
    ),
  })
  .strict();

const versionId = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const mapVersionRefSchema = z.object({
  projectId: versionId,
  versionId,
  contentDigest: digest,
}).strict();
const planVersionRefSchema = z.object({
  projectId: versionId,
  planId: versionId,
  versionId,
  semanticDigest: digest,
}).strict();
const briefVersionRefSchema = z.object({
  projectId: versionId,
  briefId: versionId,
  versionId,
  semanticDigest: digest,
}).strict();
const delegationFocusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assignment"), map: mapVersionRefSchema,
    plan: planVersionRefSchema, assignmentId: versionId }).strict(),
  z.object({ kind: z.literal("map-node"), map: mapVersionRefSchema,
    plan: planVersionRefSchema.nullable(), nodeId: versionId }).strict(),
  z.object({ kind: z.literal("brief"), brief: briefVersionRefSchema }).strict(),
]);
const delegationKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const projectSubsessionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestKey: delegationKey,
  operation: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("delegate"),
      delegations: z.array(z.object({
        delegationKey,
        outcome: z.string().min(1).max(4_096),
        kickoffContext: z.string().min(1).max(16_384).optional(),
        focus: delegationFocusSchema.optional(),
      }).strict()).min(1).max(16),
    }).strict(),
    z.object({
      kind: z.literal("refresh-focused-context"),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("self") }).strict(),
        z.object({ kind: z.literal("child"), delegationKey }).strict(),
      ]),
      expectedContextEpoch: z.number().int().positive(),
      expectedContextDigest: digest,
      focus: delegationFocusSchema.nullable(),
    }).strict(),
    z.object({
      kind: z.literal("release"),
      delegationKeys: z.array(delegationKey).min(1).max(16),
    }).strict(),
  ]),
}).strict();

export interface AgentMapToolEvent {
  tool: "agent_map_read" | "agent_map_validate" | "agent_map_propose" |
    "build_plan_read" | "build_plan_validate" | "build_plan_apply" | "build_plan_rebase" |
    "build_plan_brief_refresh" | "project_subsession_delegate";
  outcome: "ok" | "error";
  errorCode?: string;
  latencyMs: number;
}

export interface AgentMapMcpToolsOptions {
  onEvent?: (event: AgentMapToolEvent) => void;
  readSnapshot?: () => Promise<object>;
}

export class AgentMapMcpProjectUnavailableError extends Error {
  constructor() {
    super("Agent Map project is unavailable");
    this.name = "AgentMapMcpProjectUnavailableError";
  }
}

function errorResult(error: unknown) {
  const details =
    error instanceof AgentMapProposalValidationError
      ? {
          code: error.code,
          currentVersion: error.currentVersion,
          issues: error.issues,
          recovery: "correct",
        }
      : error instanceof AgentMapProposalConflictError
        ? { ...error.conflict }
        : error instanceof AgentMapProposalProjectError
          ? { code: "forbidden", recovery: "reread" }
          : error instanceof AgentMapProposalQuotaError
            ? { code: error.code, recovery: "manual_intervention" }
            : error instanceof AgentMapMcpProjectUnavailableError
              ? { code: "project_unavailable", recovery: "reread" }
              : error instanceof BuildPlanServiceError
              ? { code: error.code, ...error.details,
                  recovery: error.code === "request_id_reused" || error.code === "request_id_expired"
                    ? "new_request" : error.code.includes("conflict") || error.code.includes("source") ||
                        error.code === "plan_not_found"
                      ? "reread" : error.code.includes("validation") || error.code.includes("resolution")
                          || error.code === "malformed_input" || error.code === "request_too_large"
                        ? "correct" : error.code === "quota_exceeded"
                          ? "manual_intervention" : "retry" }
              : error instanceof AgentBriefServiceError
                ? { code: error.code,
                    recovery: error.code === "request_id_reused" || error.code === "request_id_expired"
                      ? "new_request" : error.code === "source_mismatch" ? "reread"
                        : error.code === "malformed_input" ? "correct"
                          : error.code === "quota_exceeded" ? "manual_intervention" : "retry" }
              : error instanceof SubsessionCoordinatorError
                ? error.detail
              : error instanceof AgentMapWorkspaceStoreError
                ? { code: error.code, recovery: error.code === "storage_unavailable" ? "retry" : "reread" }
              : { code: "internal_error", recovery: "retry" };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    structuredContent: details,
  };
}

function toolResult(value: object, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: value as Record<string, unknown>,
  };
}

function briefRefreshFailure(error: unknown) {
  const errorCode = error instanceof AgentBriefServiceError ? error.code : "storage_unavailable";
  return {
    outcome: errorCode === "quota_exceeded" ? "manual_intervention" as const : "retryable" as const,
    errorCode,
  };
}

/** Registers the identical project-wide surface for every trusted session. */
export function createAgentMapToolServer(
  identity: ProjectAgentSession,
  service: AgentMapProposalService,
  buildPlanService: BuildPlanService,
  agentBriefService: AgentBriefService,
  subsessionCoordinator: SubsessionCoordinator,
  options: AgentMapMcpToolsOptions = {},
): McpServer {
  const server = new McpServer({
    name: "sapiom-studio-agent-map",
    version: "1",
  });
  const emit = (event: AgentMapToolEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Content-free observability never changes a tool result.
    }
  };

  const instrument = async <T>(
    tool: AgentMapToolEvent["tool"],
    operation: () => Promise<T>,
  ) => {
    const startedAt = Date.now();
    try {
      const value = await operation();
      emit({
        tool,
        outcome: "ok",
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
      return value;
    } catch (error) {
      const result = errorResult(error);
      emit({
        tool,
        outcome: "error",
        errorCode: String(result.structuredContent.code),
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
      return result;
    }
  };

  server.registerTool(
    "agent_map_read",
    {
      description:
        "Read the current confirmed workspace and shared Agent Map proposal.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      instrument("agent_map_read", async () => {
        const snapshot = options.readSnapshot
          ? await options.readSnapshot()
          : await service.read(identity.projectId);
        const proposal = (
          snapshot as { proposal?: { version?: number } | null }
        ).proposal;
        return toolResult(
          snapshot,
          `Agent Map proposal version ${proposal?.version ?? 0}.`,
        );
      }),
  );

  server.registerTool(
    "agent_map_validate",
    {
      description:
        "Validate a complete proposal batch without mutating shared state or allocating IDs.",
      inputSchema: batchSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (request) =>
      instrument("agent_map_validate", async () => {
        const result = await service.validate(identity, request);
        return toolResult(
          result,
          `Proposal batch is valid at version ${result.currentVersion}.`,
        );
      }),
  );

  server.registerTool(
    "agent_map_propose",
    {
      description:
        "Atomically apply an idempotent batch to the shared Proposed Agent Map.",
      inputSchema: batchSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (request) =>
      instrument("agent_map_propose", async () => {
        const result = await service.propose(identity, request);
        return toolResult(
          result,
          `Accepted Agent Map proposal version ${result.version}.`,
        );
      }),
  );

  server.registerTool(
    "build_plan_read",
    {
      description: "Read the current shared build plan or one exact immutable historical version.",
      inputSchema: buildPlanReadToolInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (request) => instrument("build_plan_read", async () => {
      const result = await buildPlanService.read(identity, request);
      return toolResult(result, result.plan ? `Build plan version ${result.plan.version}.` : "No build plan exists.");
    }),
  );

  server.registerTool(
    "build_plan_validate",
    {
      description: "Preview and validate an exact-source build plan replacement without changing durable state.",
      inputSchema: buildPlanApplyRequestSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (request) => instrument("build_plan_validate", async () => {
      const result = await buildPlanService.validate(identity, request);
      return toolResult(result, `Build plan preview is valid for version ${result.preview.version}.`);
    }),
  );

  server.registerTool(
    "build_plan_apply",
    {
      description: "Atomically append an idempotent shared build plan version using exact map and plan expectations.",
      inputSchema: buildPlanApplyRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (request) => instrument("build_plan_apply", async () => {
      const result = await buildPlanService.apply(identity, request);
      const briefRefresh = await agentBriefService.refresh(identity, {
        schemaVersion: 1,
        requestId: `brief-${result.plan.versionId}`,
        expectedMap: request.expectedMap,
        expectedPlan: { planId: result.plan.planId, versionId: result.plan.versionId,
          semanticDigest: result.plan.semanticDigest },
        focus: { mode: "canonical" },
      }).catch(briefRefreshFailure);
      return toolResult({ ...result, briefRefresh }, result.created ? "Build plan version created." : "Build plan is unchanged.");
    }),
  );

  server.registerTool(
    "build_plan_rebase",
    {
      description: "Rebase the exact current build plan to the exact current map with explicit remap or removal resolutions.",
      inputSchema: buildPlanRebaseRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (request) => instrument("build_plan_rebase", async () => {
      const result = await buildPlanService.rebase(identity, request);
      const briefRefresh = await agentBriefService.refresh(identity, {
        schemaVersion: 1,
        requestId: `brief-${result.plan.versionId}`,
        expectedMap: request.toMap,
        expectedPlan: { planId: result.plan.planId, versionId: result.plan.versionId,
          semanticDigest: result.plan.semanticDigest },
        focus: { mode: "canonical" },
      }).catch(briefRefreshFailure);
      return toolResult({ ...result, briefRefresh }, result.created ? "Build plan rebased." : "Build plan rebase is unchanged.");
    }),
  );

  server.registerTool(
    "build_plan_brief_refresh",
    {
      description: "Compile or refresh exact-source canonical or focused briefs without changing plan-authoring results.",
      inputSchema: agentBriefRefreshRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (request) => instrument("build_plan_brief_refresh", async () => {
      const result = await agentBriefService.refresh(identity, request);
      return toolResult(result, result.persisted ? "Focused brief history refreshed." : "Focused briefs are unchanged.");
    }),
  );

  server.registerTool(
    "project_subsession_delegate",
    {
      description: "Create, reuse, or release a bounded batch of ordinary writable project subsessions, or refresh exact focused context, using caller-owned idempotency keys.",
      inputSchema: projectSubsessionRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (request) => instrument("project_subsession_delegate", async () => {
      const result = await subsessionCoordinator.execute(identity, request);
      return toolResult(result, `Delegation reconciled ${result.results.length} project subsession${result.results.length === 1 ? "" : "s"}.`);
    }),
  );

  return server;
}
