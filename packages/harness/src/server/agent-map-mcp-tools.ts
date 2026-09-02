import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import {
  AgentMapProposalConflictError,
  AgentMapProposalProjectError,
  AgentMapProposalService,
  AgentMapProposalValidationError,
} from "../core/agent-map-proposal-service.js";
import { AgentMapWorkspaceStoreError } from "../core/agent-map-workspace-store.js";

const batchSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().nullable(),
    expectedVersion: z.number().int().nonnegative(),
    requestId: z.string().min(1),
    operations: z.array(z.unknown()).min(1),
  })
  .strict();

export interface AgentMapToolEvent {
  tool: "agent_map_read" | "agent_map_validate" | "agent_map_propose";
  outcome: "ok" | "error";
  errorCode?: string;
  role: PlanningSessionIdentity["role"];
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
  ) => {
    const startedAt = Date.now();
    try {
      const value = await operation();
      emit({
        tool,
        outcome: "ok",
        role: identity.role,
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
      return value;
    } catch (error) {
      const result = errorResult(error);
      emit({
        tool,
        outcome: "error",
        errorCode: String(result.structuredContent.code),
        role: identity.role,
        latencyMs: Math.max(0, Date.now() - startedAt),
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

  return server;
}
