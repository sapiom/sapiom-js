/**
 * Shared types for LangChain v1.x integration
 */
import type { SapiomClient, BaseSapiomIntegrationConfig } from "@sapiom/core";

/**
 * Configuration for Sapiom middleware
 */
export interface SapiomMiddlewareConfig extends BaseSapiomIntegrationConfig {
  /**
   * Workflow trace identifier
   *
   * Purpose:
   * - Groups related transactions (LLM calls + tool calls) under one trace
   * - Enables workflow cost tracking and duration analysis
   * - Allows correlation with your distributed tracing system
   *
   * Behavior:
   * - Provided: Uses your ID (e.g., "checkout-123", "user-456-conv")
   * - Not provided: SDK auto-generates UUID with "sdk-" prefix
   *
   * Per-invoke override via context:
   * - Pass different ID in context.sapiomTraceId
   *
   * @example
   * ```typescript
   * createSapiomMiddleware({
   *   traceId: "checkout-session-abc"
   * })
   * ```
   */
  traceId?: string;

  /**
   * Agent identifier (UUID or numeric ID like AG-001)
   *
   * Purpose:
   * - Tags transactions with a specific agent for filtering and analytics
   * - Enables agent-level cost tracking and usage analysis
   *
   * Behavior:
   * - Provided: Uses existing agent with this ID
   * - Agent must be ACTIVE to be used
   * - Cannot be used with agentName
   */
  agentId?: string;

  /**
   * Agent name for find-or-create behavior
   *
   * Purpose:
   * - Automatically creates agent if it doesn't exist
   * - Convenient for dynamic agent creation
   * - Ensures consistent agent tagging across runs
   *
   * Behavior:
   * - Provided: Finds existing agent by name or creates new ACTIVE agent
   * - Cannot be used with agentId
   * - Agents are tenant-scoped (unique per organization)
   */
  agentName?: string;

  /**
   * Pre-initialized Sapiom client (internal use)
   * @internal
   */
  sapiomClient?: SapiomClient;
}

/**
 * Context passed per-invocation to override middleware config
 */
export interface SapiomMiddlewareContext {
  /**
   * Override trace ID for this invocation
   */
  sapiomTraceId?: string;

  /**
   * Override agent ID for this invocation
   */
  sapiomAgentId?: string;

  /**
   * Override agent name for this invocation
   */
  sapiomAgentName?: string;
}

/**
 * State maintained by the middleware across agent lifecycle
 * @internal
 */
export interface SapiomMiddlewareState {
  /**
   * Current trace ID for this agent execution
   */
  __sapiomTraceId?: string;

  /**
   * Agent transaction ID (created in beforeAgent)
   */
  __sapiomAgentTxId?: string;

  /**
   * Start time for duration tracking
   */
  __sapiomStartTime?: number;
}
