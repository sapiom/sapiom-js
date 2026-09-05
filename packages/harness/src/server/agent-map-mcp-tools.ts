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
import { AgentBriefAppendQuotaError, AgentMapWorkspaceStoreError } from "../core/agent-map-workspace-store.js";
import { AgentMapAggregateError } from "../core/agent-map-aggregate-migration.js";
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
    ).describe("Copy proposal.id from agent_map_read; null only when its proposal is null."),
    expectedVersion: preserveInvalidForService(
      proposalBatchRequestSchema.shape.expectedVersion,
    ).describe("Copy proposal.version from the read; 0 only for an empty proposal. Re-read after a conflict."),
    requestId: preserveInvalidForService(
      proposalBatchRequestSchema.shape.requestId,
    ).describe("Caller-chosen retry identity. Reuse for an identical batch; use a fresh ID when the batch changes."),
    operations: preserveInvalidForService(
      proposalBatchRequestSchema.shape.operations,
    ).describe("Complete atomic batch. New nodes use draftRef; existing nodes use IDs from the read. Preserve unrelated architecture."),
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
]).describe("Optional exact context, not permission. Unlike build_plan_* input refs, these refs include projectId; copy real returned IDs/digests.");
const delegationKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const projectSubsessionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestKey: delegationKey.describe("Stable caller-owned key for identical retries of this operation; changed operation content needs a fresh key."),
  operation: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("delegate"),
      delegations: z.array(z.object({
        delegationKey: delegationKey.describe("Stable child-task identity within this parent. Identical content reuses its session; different work needs a new key."),
        outcome: z.string().min(1).max(4_096).describe("Concrete implementation outcome; the child is an ordinary writable coding session."),
        kickoffContext: z.string().min(1).max(16_384).optional().describe("Owned files, boundaries, non-goals, written deliverables, and verification. Children share the parent's cwd, not isolated worktrees."),
        focus: delegationFocusSchema.optional(),
      }).strict()).min(1).max(16),
    }).strict(),
    z.object({
      kind: z.literal("refresh-focused-context"),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("self") }).strict(),
        z.object({ kind: z.literal("child"), delegationKey }).strict(),
      ]),
      expectedContextEpoch: z.number().int().positive().describe("Exact epoch from the current focused-context result; never guess."),
      expectedContextDigest: digest.describe("Exact digest paired with expectedContextEpoch."),
      focus: delegationFocusSchema.nullable(),
    }).strict(),
    z.object({
      kind: z.literal("release"),
      delegationKeys: z.array(delegationKey).min(1).max(16).describe("Only this parent's owned children. Release closes their real sessions; do not release useful active work."),
    }).strict(),
    z.object({
      kind: z.literal("release-dormant"),
      limit: z.number().int().min(1).max(16).describe("Maximum exited/failed coordinator bindings to evict project-wide. Preserves conversation history but forfeits automatic resume identity."),
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
          : error instanceof AgentMapProposalQuotaError || error instanceof AgentBriefAppendQuotaError
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
              : error instanceof AgentMapWorkspaceStoreError || error instanceof AgentMapAggregateError
                ? { code: error.code, recovery: error.code === "storage_unavailable" ? "retry" : "manual_intervention" }
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
  const details = errorResult(error).structuredContent;
  return {
    outcome: details.recovery === "retry" ? "retryable" : details.recovery,
    errorCode: details.code,
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
        "Read shared project architecture before creating or changing agents, responsibilities, contracts, resources, artifacts, or data flow. Returns workspace and proposal (null if empty), including stable IDs and the numeric proposal version for validate/propose. This is not the automatic per-agent Canvas. For exact map/plan digests use build_plan_read({kind:'current'}).",
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
        "Preview a complete Agent Map change batch without persisting it or allocating IDs. First agent_map_read; use its proposal ID/version, or null/0 when empty. Use draftRef for new nodes and their relationships. Correct reported issues, then pass the same valid batch to agent_map_propose. Validation alone never updates the visible map.",
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
        "Persist an atomic, idempotent Agent Map batch and update the shared visible graph; this is not an approval request or code execution. Read then validate first. Reuse the request ID only for an identical retry; re-read/reconcile stale versions without overwriting unrelated work. Record meaningful artifact/contract changes, not just new agents, and confirm persisted state with agent_map_read.",
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
      description: "Read with {kind:'current'} for the shared build plan (possibly null), current exact map/plan references, history, and diagnostics. Use these IDs/digests for plan authoring; agent_map_read does not provide map digests. Read {kind:'exact',planId,versionId,semanticDigest} for one immutable historical plan. An absent plan does not block coding or delegation.",
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
      description: "Validate a complete build-plan replacement without changing durable state. Read current references first; a map must exist. Supply all content collections, preserve unrelated intent, and use clientRef for new plan-owned IDs. expectedPlan is null only for the first plan. Rebase an existing plan after any map-version change, then validate and apply the identical request.",
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
      description: "Persist a validated complete build-plan replacement for substantial coordinated work, not every small edit. Use exact references from build_plan_read; replacements must preserve unrelated content. Identical request-ID retries are idempotent. The plan commits before best-effort canonical briefRefresh: inspect that separate result and retry failed refresh independently. This does not launch sessions or execute code.",
      inputSchema: buildPlanApplyRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (request) => instrument("build_plan_apply", async () => {
      const result = await buildPlanService.apply(identity, request);
      const briefRefresh = await agentBriefService.refreshAfterPlanMutation(identity, {
        expectedMap: request.expectedMap,
        expectedPlan: { planId: result.plan.planId, versionId: result.plan.versionId,
          semanticDigest: result.plan.semanticDigest },
      }).catch(briefRefreshFailure);
      return toolResult({ ...result, briefRefresh }, result.created ? "Build plan version created." : "Build plan is unchanged.");
    }),
  );

  server.registerTool(
    "build_plan_rebase",
    {
      description: "Rebind the current build plan after any map-version change before further plan edits. Read current state: fromMap is plan.map, toMap is current.map, expectedPlan is current.buildPlan; input refs omit projectId. Use resolutions:[] if all references remain valid, otherwise explicitly remap/remove invalidated references without silently dropping intent. Commits before best-effort canonical brief refresh.",
      inputSchema: buildPlanRebaseRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (request) => instrument("build_plan_rebase", async () => {
      const result = await buildPlanService.rebase(identity, request);
      const briefRefresh = await agentBriefService.refreshAfterPlanMutation(identity, {
        expectedMap: request.toMap,
        expectedPlan: { planId: result.plan.planId, versionId: result.plan.versionId,
          semanticDigest: result.plan.semanticDigest },
      }).catch(briefRefreshFailure);
      return toolResult({ ...result, briefRefresh }, result.created ? "Build plan rebased." : "Build plan rebase is unchanged.");
    }),
  );

  server.registerTool(
    "build_plan_brief_refresh",
    {
      description: "Compile context briefs from exact current matching map and plan versions. Use canonical focus for workstreams or focused selections for bounded ad-hoc assignments. Apply/rebase already attempt canonical refresh; retry this tool independently if that refresh failed. Refresh does not change plan intent, launch a session, or grant implementation authority; a running child's context refresh is a delegation operation.",
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
      description: "Delegate bounded implementation work to ordinary writable children when parallel work or focused context helps. operation.kind='delegate' uses stable requestKey and per-child delegationKey, outcome, and optional kickoffContext/focus; no map or plan is required. Children share cwd, so specify non-overlapping ownership and written deliverables. Ready/acknowledged is kickoff state, not completed work; inspect and test deliverables. Other operations refresh exact focused context, release owned children (closing sessions), or release-dormant project-wide (forfeiting dormant resume bindings, preserving history). Never reconcile unrelated user sessions.",
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
