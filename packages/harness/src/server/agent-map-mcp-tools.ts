import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProjectAgentSession } from "@sapiom/agent-map";
import {
  AgentMapProposalConflictError,
  AgentMapProposalProjectError,
  AgentMapProposalQuotaError,
  AgentMapProposalService,
  AgentMapProposalValidationError,
} from "@sapiom/agent-map/node/agent-map-proposal-service";
import { proposalBatchRequestSchema } from "@sapiom/agent-map/schema";
import { AgentMapWorkspaceStoreError } from "@sapiom/agent-map/node/agent-map-workspace-store";
import { AgentMapAggregateError } from "@sapiom/agent-map/node/agent-map-aggregate-migration";

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

export interface AgentMapToolEvent {
  tool: "agent_map_read" | "agent_map_validate" | "agent_map_propose";
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

/** Registers the identical project-wide surface for every trusted session. */
export function createAgentMapToolServer(
  identity: ProjectAgentSession,
  service: AgentMapProposalService,
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
        "Read shared project architecture before creating or changing agents, responsibilities, contracts, resources, artifacts, or data flow. Returns workspace and proposal (null if empty), including stable IDs and the numeric proposal version for validate/propose. This is not the automatic per-agent Canvas.",
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

  return server;
}
