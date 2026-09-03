import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import {
  AgentMapProposalConflictError,
  AgentMapProposalProjectError,
  AgentMapProposalService,
  AgentMapProposalValidationError,
} from "../core/agent-map-proposal-service.js";
import { proposalBatchRequestSchema } from "../core/agent-map-proposal-schema.js";
import { AgentMapWorkspaceStoreError } from "../core/agent-map-workspace-store.js";
import {
  BuildPlanService,
  BuildPlanServiceError,
} from "../core/build-plan-service.js";
import {
  buildPlanApplyRequestSchema,
  buildPlanReadInputSchema,
  buildPlanRebaseRequestSchema,
  buildPlanValidateRequestSchema,
} from "../core/build-plan-schema.js";

/**
 * MCP discovery sees the complete SAP-3061 input contract. Field-level `catch`
 * deliberately returns invalid values unchanged at execution time so the
 * proposal service, rather than the SDK's generic InvalidParams path, can
 * translate them into our bounded validation issues and recovery guidance.
 * zod-to-json-schema renders each ZodCatch from its inner schema; the final
 * refinement keeps every envelope field required in the advertised contract.
 */
const preserveInvalidForService = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  schema
    .catch(
      (context: { input: unknown }) => context.input as z.output<Schema>,
    )
    .refine((value) => value !== undefined);
const preserveOptionalInvalidForService = <Schema extends z.ZodTypeAny>(
  schema: Schema,
) =>
  schema.catch(
    (context: { input: unknown }) => context.input as z.output<Schema>,
  );

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

const planReadSchema = z
  .object({
    schemaVersion: preserveInvalidForService(
      buildPlanReadInputSchema.shape.schemaVersion,
    ),
    plan: preserveOptionalInvalidForService(
      buildPlanReadInputSchema.shape.plan,
    ),
    include: preserveOptionalInvalidForService(
      buildPlanReadInputSchema.shape.include,
    ),
  })
  .strict();
const planValidateSchema = z
  .object({
    schemaVersion: preserveInvalidForService(
      buildPlanValidateRequestSchema.shape.schemaVersion,
    ),
    planId: preserveInvalidForService(
      buildPlanValidateRequestSchema.shape.planId,
    ),
    expectedPlanVersion: preserveInvalidForService(
      buildPlanValidateRequestSchema.shape.expectedPlanVersion,
    ),
    expectedSource: preserveInvalidForService(
      buildPlanValidateRequestSchema.shape.expectedSource,
    ),
    operations: preserveInvalidForService(
      buildPlanValidateRequestSchema.shape.operations,
    ),
  })
  .strict();
const planApplySchema = planValidateSchema.extend({
  requestId: preserveInvalidForService(
    buildPlanApplyRequestSchema.shape.requestId,
  ),
});
const planRebaseSchema = z
  .object({
    schemaVersion: preserveInvalidForService(
      buildPlanRebaseRequestSchema.shape.schemaVersion,
    ),
    planId: preserveInvalidForService(
      buildPlanRebaseRequestSchema.shape.planId,
    ),
    expectedPlanVersion: preserveInvalidForService(
      buildPlanRebaseRequestSchema.shape.expectedPlanVersion,
    ),
    fromSource: preserveInvalidForService(
      buildPlanRebaseRequestSchema.shape.fromSource,
    ),
    toSource: preserveInvalidForService(
      buildPlanRebaseRequestSchema.shape.toSource,
    ),
    requestId: preserveInvalidForService(
      buildPlanRebaseRequestSchema.shape.requestId,
    ),
    resolutions: preserveInvalidForService(
      buildPlanRebaseRequestSchema.shape.resolutions,
    ),
  })
  .strict();

export interface AgentMapToolEvent {
  tool:
    | "agent_map_read"
    | "agent_map_validate"
    | "agent_map_propose"
    | "build_plan_read"
    | "build_plan_validate"
    | "build_plan_apply"
    | "build_plan_rebase";
  outcome: "ok" | "error";
  errorCode?: string;
  role: PlanningSessionIdentity["role"];
  projectId: string;
  sessionId: string;
  latencyMs: number;
  operationCount?: number;
  diagnosticCount?: number;
  replayed?: boolean;
  conflict?: boolean;
  planVersion?: number;
  sourceKind?: "proposal" | "revision";
  sourceVersion?: number;
  briefCounts?: Readonly<{
    created: number;
    changed: number;
    staled: number;
    preserved: number;
  }>;
}

export interface AgentMapMcpToolsOptions {
  onEvent?: (event: AgentMapToolEvent) => void;
  readSnapshot?: () => Promise<object>;
  buildPlanService?: BuildPlanService;
}

export class AgentMapMcpProjectUnavailableError extends Error {
  constructor() {
    super("Agent Map project is unavailable");
    this.name = "AgentMapMcpProjectUnavailableError";
  }
}

function errorResult(error: unknown) {
  const details =
    error instanceof BuildPlanServiceError
      ? {
          code: error.code,
          issues: error.issues.slice(0, 64),
          ...(error.currentPlan ? { currentPlan: error.currentPlan } : {}),
          recovery:
            error.code === "plan_version_conflict" ||
            error.code === "source_mismatch"
              ? "reread"
              : error.code === "authoring_unavailable" ||
                  error.code === "revision_source_unavailable"
                ? "dependency_required"
                : error.code === "idempotency_key_reused"
                  ? "new_request_id"
                  : error.code === "result_too_large"
                    ? "split_batch"
                    : "correct",
        }
      : error instanceof AgentMapProposalValidationError
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
            : error instanceof AgentMapMcpProjectUnavailableError
              ? { code: "project_unavailable", recovery: "reread" }
              : error instanceof AgentMapWorkspaceStoreError
                ? { code: "storage_unavailable", recovery: "retry" }
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

/** Registers the identical project-wide surface for every trusted role. */
export function createAgentMapToolServer(
  identity: PlanningSessionIdentity,
  service: AgentMapProposalService,
  options: AgentMapMcpToolsOptions = {},
): McpServer {
  const server = new McpServer({ name: "sapiom-studio-agent-map", version: "1" });
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
    readOperationCount?: () => number | undefined,
  ) => {
    const startedAt = Date.now();
    let operationCount: number | undefined;
    try {
      operationCount = readOperationCount?.();
      const value = await operation();
      const structured = (
        value as {
          structuredContent?: {
            diagnostics?: unknown[];
            replayed?: boolean;
            plan?: { version?: number };
            source?: {
              kind?: "proposal" | "revision";
              version?: number;
              revisionNumber?: number;
            };
            briefChanges?: Array<{
              change?: "created" | "changed" | "staled" | "preserved";
            }>;
          };
        }
      ).structuredContent;
      const changes = structured?.briefChanges ?? [];
      emit({
        tool,
        outcome: "ok",
        role: identity.role,
        projectId: identity.projectId,
        sessionId: identity.sessionId,
        latencyMs: Math.max(0, Date.now() - startedAt),
        ...(operationCount === undefined ? {} : { operationCount }),
        diagnosticCount: structured?.diagnostics?.length ?? 0,
        replayed: structured?.replayed ?? false,
        planVersion: structured?.plan?.version,
        sourceKind: structured?.source?.kind,
        sourceVersion:
          structured?.source?.kind === "revision"
            ? structured.source.revisionNumber
            : structured?.source?.version,
        briefCounts: {
          created: changes.filter(({ change }) => change === "created").length,
          changed: changes.filter(({ change }) => change === "changed").length,
          staled: changes.filter(({ change }) => change === "staled").length,
          preserved: changes.filter(({ change }) => change === "preserved")
            .length,
        },
      });
      return value;
    } catch (error) {
      const result = errorResult(error);
      emit({
        tool,
        outcome: "error",
        errorCode: String(result.structuredContent.code),
        role: identity.role,
        projectId: identity.projectId,
        sessionId: identity.sessionId,
        latencyMs: Math.max(0, Date.now() - startedAt),
        ...(operationCount === undefined ? {} : { operationCount }),
        conflict: [
          "plan_version_conflict",
          "source_mismatch",
          "rebase_conflict",
        ].includes(String(result.structuredContent.code)),
      });
      return result;
    }
  };

  server.registerTool(
    "agent_map_read",
    {
      description: "Read the current confirmed workspace and shared Agent Map proposal.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      instrument("agent_map_read", async () => {
        const snapshot = options.readSnapshot
          ? await options.readSnapshot()
          : await service.read(identity.projectId);
        const proposal = (snapshot as { proposal?: { version?: number } | null }).proposal;
        return toolResult(snapshot, `Agent Map proposal version ${proposal?.version ?? 0}.`);
      }),
  );

  server.registerTool(
    "agent_map_validate",
    {
      description: "Validate a complete proposal batch without mutating shared state or allocating IDs.",
      inputSchema: batchSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (request) =>
      instrument("agent_map_validate", async () => {
        const result = await service.validate(identity, request);
        return toolResult(result, `Proposal batch is valid at version ${result.currentVersion}.`);
      }),
  );

  server.registerTool(
    "agent_map_propose",
    {
      description: "Atomically apply an idempotent batch to the shared Proposed Agent Map.",
      inputSchema: batchSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (request) =>
      instrument("agent_map_propose", async () => {
        const result = await service.propose(identity, request);
        return toolResult(result, `Accepted Agent Map proposal version ${result.version}.`);
      }),
  );

  if (identity.role === "map-planner" && options.buildPlanService) {
    const planService = options.buildPlanService;
    server.registerTool(
      "build_plan_read",
      {
        description:
          "Read an exact current or historical delivery build plan and its bounded status.",
        inputSchema: planReadSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (request) =>
        instrument("build_plan_read", async () => {
          const result = await planService.read(identity, request);
          return toolResult(
            result,
            `Build plan version ${result.plan.version}.`,
          );
        }),
    );
    server.registerTool(
      "build_plan_validate",
      {
        description:
          "Validate an atomic delivery-plan batch against exact plan and architecture versions without side effects.",
        inputSchema: planValidateSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (request) =>
        instrument(
          "build_plan_validate",
          async () => {
            const result = await planService.validate(identity, request);
            return toolResult(
              result,
              `Build plan batch is valid for version ${result.plan.version}.`,
            );
          },
          () =>
            Array.isArray(request.operations)
              ? request.operations.length
              : undefined,
        ),
    );
    server.registerTool(
      "build_plan_apply",
      {
        description:
          "Atomically apply an idempotent delivery-plan batch at exact plan and architecture versions.",
        inputSchema: planApplySchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (request) =>
        instrument(
          "build_plan_apply",
          async () => {
            const result = await planService.apply(identity, request);
            return toolResult(
              result,
              `Accepted build plan version ${result.plan.version}.`,
            );
          },
          () =>
            Array.isArray(request.operations)
              ? request.operations.length
              : undefined,
        ),
    );
    server.registerTool(
      "build_plan_rebase",
      {
        description:
          "Explicitly rebind a current build plan between two exact architecture sources with explicit conflict resolutions.",
        inputSchema: planRebaseSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (request) =>
        instrument(
          "build_plan_rebase",
          async () => {
            const result = await planService.rebase(identity, request);
            return toolResult(
              result,
              `Rebased build plan to version ${result.plan.version}.`,
            );
          },
          () =>
            Array.isArray(request.resolutions)
              ? request.resolutions.length
              : undefined,
        ),
    );
  }

  return server;
}
