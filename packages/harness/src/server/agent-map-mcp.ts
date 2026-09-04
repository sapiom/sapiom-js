import { randomUUID } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  AgentMapCapabilityError,
  AgentMapCapabilityRegistry,
  type ResolvedAgentMapCapability,
} from "../core/agent-map-capability-registry.js";
import type { AgentMapProposalService } from "../core/agent-map-proposal-service.js";
import type { BuildPlanService } from "../core/build-plan-service.js";
import { createAgentMapToolServer, type AgentMapMcpToolsOptions } from "./agent-map-mcp-tools.js";

interface BoundTransport {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  capability: ResolvedAgentMapCapability;
  lastUsedAt: number;
}

export interface AgentMapMcpRouterOptions
  extends Omit<AgentMapMcpToolsOptions, "readSnapshot"> {
  capabilities: AgentMapCapabilityRegistry;
  service: AgentMapProposalService;
  buildPlanService: BuildPlanService;
  readSnapshotFor?: (identity: ResolvedAgentMapCapability["identity"]) => Promise<object>;
  maxSessions?: number;
  now?: () => number;
  /** Deterministic lifecycle seam for transport-failure regression tests. */
  createTransport?: (
    options: StreamableHTTPServerTransportOptions,
  ) => StreamableHTTPServerTransport;
  /** Deterministic lifecycle seam for MCP-server cleanup regression tests. */
  createToolServer?: typeof createAgentMapToolServer;
}

export interface AgentMapMcpRouter {
  router: Router;
  revokeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

const bearer = (request: Request): string | null => {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return token ? token : null;
};

const protocolError = (response: Response, status: number, message: string) =>
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });

/** Stateful Streamable HTTP router with capability-generation pinning. */
export function createAgentMapMcpRouter(options: AgentMapMcpRouterOptions): AgentMapMcpRouter {
  const router = Router();
  router.use(express.json({ limit: "1mb" }));
  const sessions = new Map<string, BoundTransport>();
  const now = options.now ?? Date.now;
  const maxSessions = options.maxSessions ?? 64;
  const createTransport =
    options.createTransport ??
    ((transportOptions: StreamableHTTPServerTransportOptions) =>
      new StreamableHTTPServerTransport(transportOptions));
  const createToolServer = options.createToolServer ?? createAgentMapToolServer;

  const authenticate = (request: Request, response: Response) => {
    const token = bearer(request);
    if (!token) {
      protocolError(response, 401, "Missing Agent Map capability");
      return null;
    }
    try {
      return options.capabilities.resolve(token);
    } catch (error) {
      const status = error instanceof AgentMapCapabilityError ? 401 : 403;
      protocolError(response, status, "Agent Map capability rejected");
      return null;
    }
  };

  const resolveBound = (request: Request, response: Response, capability: ResolvedAgentMapCapability) => {
    const sessionId = request.header("mcp-session-id");
    const bound = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId || !bound) {
      protocolError(response, 404, "MCP session not found");
      return null;
    }
    if (
      bound.capability.identity.sessionId !== capability.identity.sessionId ||
      bound.capability.generation !== capability.generation ||
      !options.capabilities.isGenerationLive(
        capability.identity.sessionId,
        capability.generation,
      )
    ) {
      protocolError(response, 403, "MCP session capability mismatch");
      return null;
    }
    bound.lastUsedAt = now();
    return bound;
  };

  const closeBound = async (
    sessionId: string | undefined,
    bound: BoundTransport,
  ) => {
    if (sessionId && sessions.get(sessionId) === bound) {
      sessions.delete(sessionId);
    }
    // McpServer owns its connected transport. If its close fails during a
    // partial connect, still make a direct best-effort transport close.
    await bound.server.close().catch(async () => {
      await bound.transport.close().catch(() => {});
    });
  };

  router.post("/mcp/agent-map", async (request, response) => {
    const capability = authenticate(request, response);
    if (!capability) return;
    const requestedSessionId = request.header("mcp-session-id");
    if (requestedSessionId) {
      const bound = resolveBound(request, response, capability);
      if (!bound) return;
      await bound.transport.handleRequest(request, response, request.body).catch(() => {
        if (!response.headersSent) protocolError(response, 500, "Agent Map MCP request failed");
      });
      return;
    }
    if (!isInitializeRequest(request.body)) {
      protocolError(response, 400, "Initialize request required");
      return;
    }
    if (sessions.size >= maxSessions) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (oldest) await closeBound(oldest[0], oldest[1]);
    }
    const transport = createTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, bound);
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
    };
    const server = createToolServer(capability.identity, options.service, options.buildPlanService, {
      onEvent: options.onEvent,
      ...(options.readSnapshotFor
        ? {
            readSnapshot: () => options.readSnapshotFor!(capability.identity),
          }
        : {}),
    });
    const bound: BoundTransport = { transport, server, capability, lastUsedAt: now() };
    await (async () => {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    })().catch(async () => {
      await closeBound(transport.sessionId, bound);
      if (!response.headersSent) protocolError(response, 500, "Agent Map MCP request failed");
    });
  });

  for (const method of ["get", "delete"] as const) {
    router[method]("/mcp/agent-map", async (request, response) => {
      const capability = authenticate(request, response);
      if (!capability) return;
      const bound = resolveBound(request, response, capability);
      if (!bound) return;
      await bound.transport.handleRequest(request, response).catch(() => {
        if (!response.headersSent) protocolError(response, 500, "Agent Map MCP request failed");
      });
    });
  }

  return {
    router,
    revokeSession: async (sessionId) => {
      const matching = [...sessions.entries()].filter(
        ([, bound]) => bound.capability.identity.sessionId === sessionId,
      );
      await Promise.all(matching.map(([id, bound]) => closeBound(id, bound)));
    },
    close: async () => {
      const current = [...sessions.entries()];
      sessions.clear();
      await Promise.all(current.map(([id, bound]) => closeBound(id, bound)));
    },
  };
}
