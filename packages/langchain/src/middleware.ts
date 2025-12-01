/**
 * Sapiom Middleware for LangChain v1.x
 *
 * Single middleware that handles all Sapiom tracking:
 * - Agent lifecycle (beforeAgent/afterAgent)
 * - Model calls (wrapModelCall)
 * - Tool calls (wrapToolCall)
 *
 * @example
 * ```typescript
 * import { createAgent } from "langchain";
 * import { createSapiomMiddleware } from "@sapiom/langchain";
 *
 * const agent = createAgent({
 *   model: "gpt-4",
 *   tools: [getWeather, sendEmail],
 *   middleware: [
 *     createSapiomMiddleware({
 *       apiKey: process.env.SAPIOM_API_KEY,
 *     }),
 *   ],
 * });
 * ```
 */

import {
  initializeSapiomClient,
  TransactionAuthorizer,
  type SapiomClient,
} from "@sapiom/core";

import type {
  SapiomMiddlewareConfig,
  SapiomMiddlewareContext,
  SapiomMiddlewareState,
} from "./internal/types";
import {
  generateSDKTraceId,
  isAuthorizationDeniedOrTimeout,
  SDK_NAME,
  SDK_VERSION,
} from "./internal/utils";
import {
  isMCPPaymentError,
  extractPaymentFromMCPError,
  convertX402ToSapiomPayment,
  getPaymentAuthFromTransaction,
} from "./internal/payment";
import {
  estimateInputTokens,
  getModelId,
  extractActualTokens,
} from "./internal/telemetry";

/**
 * LangChain v1.x middleware hook types
 *
 * These types represent the middleware interface from LangChain v1.x.
 * We define them here to avoid requiring langchain as a compile-time dependency.
 */

/** Model request passed to wrapModelCall */
export interface ModelRequest {
  model: unknown;
  messages: Array<{ content?: unknown; role?: string }>;
  tools: unknown[];
  state: Record<string, unknown>;
  runtime: { context?: SapiomMiddlewareContext };
}

/** Model response from handler */
export interface ModelResponse {
  tool_calls?: Array<{ name: string }>;
  usage_metadata?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
  };
  response_metadata?: {
    finish_reason?: string;
  };
}

/** Tool call request passed to wrapToolCall */
export interface ToolCallRequest {
  toolCall: {
    name: string;
    args?: Record<string, unknown>;
    id?: string;
  };
  tool: {
    name: string;
    description?: string;
  };
  state: Record<string, unknown>;
  runtime: { context?: SapiomMiddlewareContext };
}

/** Middleware definition returned by createSapiomMiddleware */
export interface SapiomMiddleware {
  name: string;

  /** Called once at agent start */
  beforeAgent?: (
    state: Record<string, unknown>,
    runtime: { context?: SapiomMiddlewareContext }
  ) => Promise<SapiomMiddlewareState>;

  /** Called once at agent end */
  afterAgent?: (
    state: Record<string, unknown> & SapiomMiddlewareState,
    runtime: { context?: SapiomMiddlewareContext }
  ) => Promise<void>;

  /** Wraps each model call */
  wrapModelCall?: (
    request: ModelRequest,
    handler: (request: ModelRequest) => Promise<ModelResponse>
  ) => Promise<ModelResponse>;

  /** Wraps each tool call */
  wrapToolCall?: <T>(
    request: ToolCallRequest,
    handler: (request: ToolCallRequest) => Promise<T>
  ) => Promise<T>;
}

/**
 * Create Sapiom middleware for LangChain v1.x agents
 *
 * This middleware automatically tracks:
 * - Agent invocations (start/end lifecycle)
 * - Model calls (token estimation, actual usage)
 * - Tool calls (pre-authorization, payment retry)
 *
 * @param config - Sapiom configuration
 * @returns Middleware object compatible with LangChain createAgent
 *
 * @example Basic usage
 * ```typescript
 * const agent = createAgent({
 *   model: "gpt-4",
 *   tools: [getWeather],
 *   middleware: [
 *     createSapiomMiddleware({
 *       apiKey: process.env.SAPIOM_API_KEY,
 *     }),
 *   ],
 * });
 * ```
 *
 * @example With configuration
 * ```typescript
 * createSapiomMiddleware({
 *   apiKey: process.env.SAPIOM_API_KEY,
 *   failureMode: "open",  // or "closed"
 *   traceId: "my-workflow",
 *   agentName: "customer-support-bot",
 * })
 * ```
 *
 * @example Per-invocation override
 * ```typescript
 * await agent.invoke(
 *   { messages: [...] },
 *   { context: { sapiomTraceId: "conversation-456" } }
 * );
 * ```
 */
export function createSapiomMiddleware(
  config: SapiomMiddlewareConfig = {}
): SapiomMiddleware {
  // Initialize Sapiom client
  const sapiomClient: SapiomClient =
    config.sapiomClient ?? initializeSapiomClient(config);
  const authorizer = new TransactionAuthorizer({ sapiomClient });
  const failureMode = config.failureMode ?? "open";
  const isEnabled = config.enabled !== false;

  return {
    name: "SapiomMiddleware",

    // ================================================================
    // AGENT LIFECYCLE: beforeAgent
    // ================================================================
    beforeAgent: async (state, runtime) => {
      if (!isEnabled) {
        return {};
      }

      const startTime = Date.now();

      // Resolve trace ID: context override > config > auto-generate
      const traceId =
        runtime.context?.sapiomTraceId ?? config.traceId ?? generateSDKTraceId();

      // Resolve agent identity
      const agentId = runtime.context?.sapiomAgentId ?? config.agentId;
      const agentName = runtime.context?.sapiomAgentName ?? config.agentName;

      try {
        const agentTx = await authorizer.createAndAuthorize({
          requestFacts: {
            source: "langchain-agent",
            version: "v1",
            sdk: { name: SDK_NAME, version: SDK_VERSION },
            request: {
              agentType: "react",
              entryMethod: "invoke",
              messageCount: Array.isArray(state.messages)
                ? state.messages.length
                : 0,
              timestamp: new Date().toISOString(),
            },
          },
          traceExternalId: traceId,
          agentId,
          agentName,
        } as unknown as Parameters<typeof authorizer.createAndAuthorize>[0]);

        return {
          __sapiomTraceId: traceId,
          __sapiomAgentTxId: agentTx.id,
          __sapiomStartTime: startTime,
        };
      } catch (error) {
        // Always throw authorization denials
        if (isAuthorizationDeniedOrTimeout(error)) {
          throw error;
        }

        // Handle based on failure mode
        if (failureMode === "closed") {
          throw error;
        }

        console.error(
          "[Sapiom] Agent transaction failed, continuing without tracking:",
          error
        );
        return {
          __sapiomTraceId: traceId,
          __sapiomStartTime: startTime,
        };
      }
    },

    // ================================================================
    // AGENT LIFECYCLE: afterAgent
    // ================================================================
    afterAgent: async (state, _runtime) => {
      if (!isEnabled || !state.__sapiomAgentTxId) {
        return;
      }

      const duration = state.__sapiomStartTime
        ? Date.now() - (state.__sapiomStartTime as number)
        : 0;

      const txId = state.__sapiomAgentTxId as string;

      // Complete transaction with response facts (fire-and-forget)
      sapiomClient.transactions
        .complete(txId, {
          outcome: "success",
          responseFacts: {
            source: "langchain-agent",
            version: "v1",
            facts: {
              success: true,
              durationMs: duration,
              outputMessageCount: Array.isArray(state.messages)
                ? state.messages.length
                : 0,
            },
          },
        })
        .catch((err) => {
          console.error("[Sapiom] Failed to complete agent transaction:", err);
        });
    },

    // ================================================================
    // MODEL CALL WRAPPING
    // ================================================================
    wrapModelCall: async (request, handler) => {
      if (!isEnabled) {
        return handler(request);
      }

      const startTime = Date.now();
      const traceId = request.state.__sapiomTraceId as string | undefined;

      // Estimate input tokens
      const estimatedTokens = estimateInputTokens(request.messages);
      const modelId = getModelId(request.model);

      // Create and authorize LLM transaction
      let llmTx: { id: string } | undefined;
      try {
        llmTx = await authorizer.createAndAuthorize({
          requestFacts: {
            source: "langchain-llm",
            version: "v1",
            sdk: { name: SDK_NAME, version: SDK_VERSION },
            request: {
              modelId,
              estimatedInputTokens: estimatedTokens,
              messageCount: request.messages.length,
              hasTools: request.tools.length > 0,
              toolCount: request.tools.length,
              timestamp: new Date().toISOString(),
            },
          },
          traceExternalId: traceId,
        } as unknown as Parameters<typeof authorizer.createAndAuthorize>[0]);
      } catch (error) {
        if (isAuthorizationDeniedOrTimeout(error)) {
          throw error;
        }
        if (failureMode === "closed") {
          throw error;
        }
        console.error(
          "[Sapiom] LLM transaction failed, continuing without tracking:",
          error
        );
        return handler(request);
      }

      // Execute model call
      const result = await handler(request);
      const duration = Date.now() - startTime;

      // Complete transaction with response facts (fire-and-forget)
      if (llmTx) {
        const actualUsage = extractActualTokens(result);
        const toolCalls = result.tool_calls ?? [];

        sapiomClient.transactions
          .complete(llmTx.id, {
            outcome: "success",
            responseFacts: {
              source: "langchain-llm",
              version: "v1",
              facts: {
                actualInputTokens: actualUsage?.promptTokens ?? 0,
                actualOutputTokens: actualUsage?.completionTokens ?? 0,
                actualTotalTokens: actualUsage?.totalTokens ?? 0,
                durationMs: duration,
                hadToolCalls: toolCalls.length > 0,
                toolCallCount: toolCalls.length,
                toolCallNames: toolCalls.map((tc) => tc.name),
                finishReason: result.response_metadata?.finish_reason,
              },
            },
          })
          .catch((err) => {
            console.error("[Sapiom] Failed to complete LLM transaction:", err);
          });
      }

      return result;
    },

    // ================================================================
    // TOOL CALL WRAPPING
    // ================================================================
    wrapToolCall: async (request, handler) => {
      if (!isEnabled) {
        return handler(request);
      }

      const startTime = Date.now();
      const traceId = request.state.__sapiomTraceId as string | undefined;
      const args = request.toolCall.args ?? {};

      // Create and authorize tool transaction
      let toolTx: { id: string } | undefined;
      try {
        toolTx = await authorizer.createAndAuthorize({
          requestFacts: {
            source: "langchain-tool",
            version: "v1",
            sdk: { name: SDK_NAME, version: SDK_VERSION },
            request: {
              toolName: request.tool.name,
              toolDescription: request.tool.description,
              hasArguments: Object.keys(args).length > 0,
              argumentKeys: Object.keys(args),
              timestamp: new Date().toISOString(),
            },
          },
          traceExternalId: traceId,
        } as unknown as Parameters<typeof authorizer.createAndAuthorize>[0]);
      } catch (error) {
        if (isAuthorizationDeniedOrTimeout(error)) {
          throw error;
        }
        if (failureMode === "closed") {
          throw error;
        }
        console.error(
          "[Sapiom] Tool transaction failed, continuing without tracking:",
          error
        );
        return handler(request);
      }

      // Execute tool call with payment retry handling
      try {
        const result = await handler(request);
        const duration = Date.now() - startTime;

        // Complete transaction with response facts (fire-and-forget)
        if (toolTx) {
          sapiomClient.transactions
            .complete(toolTx.id, {
              outcome: "success",
              responseFacts: {
                source: "langchain-tool",
                version: "v1",
                facts: {
                  success: true,
                  durationMs: duration,
                },
              },
            })
            .catch((err) => {
              console.error(
                "[Sapiom] Failed to complete tool transaction:",
                err
              );
            });
        }

        return result;
      } catch (error) {
        // Handle MCP 402 Payment Required
        if (isMCPPaymentError(error)) {
          const paymentData = extractPaymentFromMCPError(
            error as Record<string, unknown>
          );

          // Create and authorize payment transaction
          const paymentTx = await authorizer.createAndAuthorize({
            paymentData: convertX402ToSapiomPayment(paymentData),
            traceExternalId: traceId,
            qualifiers: { parentTxId: toolTx?.id },
          } as unknown as Parameters<typeof authorizer.createAndAuthorize>[0]);

          const paymentAuth = getPaymentAuthFromTransaction(
            paymentTx as unknown as Record<string, unknown>
          );

          // Retry with payment in args
          const retryRequest: ToolCallRequest = {
            ...request,
            toolCall: {
              ...request.toolCall,
              args: {
                ...args,
                _meta: {
                  ...((args._meta as Record<string, unknown>) ?? {}),
                  "x402/payment": paymentAuth,
                },
              },
            },
          };

          return handler(retryRequest);
        }

        // Complete transaction with error facts (fire-and-forget)
        const duration = Date.now() - startTime;
        if (toolTx) {
          sapiomClient.transactions
            .complete(toolTx.id, {
              outcome: "error",
              responseFacts: {
                source: "langchain-tool",
                version: "v1",
                facts: {
                  errorType:
                    (error as Error)?.constructor?.name ?? "UnknownError",
                  errorMessage: (error as Error)?.message ?? String(error),
                  durationMs: duration,
                  isMCPPaymentError: false,
                },
              },
            })
            .catch((err) => {
              console.error(
                "[Sapiom] Failed to complete tool transaction:",
                err
              );
            });
        }

        throw error;
      }
    },
  };
}

// Re-export types
export type { SapiomMiddlewareConfig, SapiomMiddlewareContext };
