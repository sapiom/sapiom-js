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
 *   model: "openai:gpt-4",
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

import type { AgentMiddleware, ToolCallRequest } from "langchain";

import type {
  SapiomMiddlewareConfig,
  SapiomMiddlewareContext,
} from "./internal/types.js";
import {
  generateSDKTraceId,
  isAuthorizationDeniedOrTimeout,
  SDK_NAME,
  SDK_VERSION,
} from "./internal/utils.js";
import {
  isMCPPaymentError,
  extractPaymentFromMCPError,
  convertX402ToSapiomPayment,
  getPaymentAuthFromTransaction,
} from "./internal/payment.js";
import {
  estimateInputTokens,
  getModelId,
  getModelClass,
  extractActualTokens,
  collectMessageContext,
  collectToolUsage,
  captureUserCallSite,
  collectDependencyVersions,
  getRuntimeInfo,
  extractModelParameters,
} from "./internal/telemetry.js";

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
 *   model: "openai:gpt-4",
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
  config: SapiomMiddlewareConfig = {},
): AgentMiddleware {
  // Initialize Sapiom client
  const sapiomClient: SapiomClient =
    config.sapiomClient ?? initializeSapiomClient(config);
  const authorizer = new TransactionAuthorizer({ sapiomClient });
  const failureMode = config.failureMode ?? "open";
  const isEnabled = config.enabled !== false;

  // Fallback trace ID for when hooks are called without beforeAgent
  // (e.g., direct model/tool usage without agent wrapper)
  const fallbackTraceId = config.traceId ?? generateSDKTraceId();

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
        runtime.context?.sapiomTraceId ??
        config.traceId ??
        generateSDKTraceId();

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
          __sapiomAgentId: agentId,
          __sapiomAgentName: agentName,
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
          error,
        );
        return {
          __sapiomTraceId: traceId,
          __sapiomStartTime: startTime,
          __sapiomAgentId: agentId,
          __sapiomAgentName: agentName,
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

      const txId = state.__sapiomAgentTxId as string;

      // Clear the transaction ID immediately to prevent double-completion
      // (ReAct agents may loop and call afterAgent multiple times)
      delete (state as Record<string, unknown>).__sapiomAgentTxId;

      const duration = state.__sapiomStartTime
        ? Date.now() - (state.__sapiomStartTime as number)
        : 0;

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
      // Use state trace ID if available, otherwise fall back to middleware-level ID
      const traceId =
        (request.state.__sapiomTraceId as string | undefined) ??
        fallbackTraceId;
      const agentId =
        (request.state.__sapiomAgentId as string | undefined) ?? config.agentId;
      const agentName =
        (request.state.__sapiomAgentName as string | undefined) ??
        config.agentName;

      // Collect telemetry
      const estimatedTokens = estimateInputTokens(request.messages);
      const modelId = getModelId(request.model);
      const modelClass = getModelClass(request.model);
      const callSite = captureUserCallSite();
      const messageContext = collectMessageContext(request.messages);
      const toolUsage = collectToolUsage(request.tools);
      const modelParams = extractModelParameters(request.model);

      // Build request facts following langchain-llm-v1 schema
      const requestFacts = {
        // Model identity
        framework: "langchain" as const,
        modelClass,
        modelId,

        // Call metadata
        entryMethod: "invoke" as const,
        isStreaming: false,
        batchSize: 1,

        // Call site
        callSite,

        // Token estimation
        estimatedInputTokens: estimatedTokens,
        tokenEstimationMethod: "approximate" as const,

        // Model parameters
        temperature: modelParams.temperature,
        maxTokens: modelParams.maxTokens,
        topP: modelParams.topP,
        stopSequences: modelParams.stopSequences,

        // Tool usage
        tools: toolUsage.enabled ? toolUsage : undefined,

        // Message context
        messages: messageContext,

        // LangChain context
        langchain: {
          hasCallbacks: false, // Middleware doesn't have direct callback access
          callbackCount: 0,
        },

        // Timestamp
        timestamp: new Date().toISOString(),
      };

      // Create and authorize LLM transaction
      let llmTx: { id: string } | undefined;
      try {
        // Collect SDK info (done here to avoid overhead if tracking is disabled)
        const runtime = getRuntimeInfo();
        const dependencies = collectDependencyVersions();

        llmTx = await authorizer.createAndAuthorize({
          requestFacts: {
            source: "langchain-llm",
            version: "v1",
            sdk: {
              name: SDK_NAME,
              version: SDK_VERSION,
              nodeVersion: runtime.nodeVersion,
              platform: runtime.platform,
              dependencies,
            },
            request: requestFacts,
          },
          traceExternalId: traceId,
          agentId,
          agentName,
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
          error,
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
      // Use state trace ID if available, otherwise fall back to middleware-level ID
      const traceId =
        (request.state.__sapiomTraceId as string | undefined) ??
        fallbackTraceId;
      const agentId =
        (request.state.__sapiomAgentId as string | undefined) ?? config.agentId;
      const agentName =
        (request.state.__sapiomAgentName as string | undefined) ??
        config.agentName;
      const args = request.toolCall.args ?? {};

      // Get tool name and description safely (works for both ClientTool and ServerTool)
      const toolName =
        (request.tool as { name?: string }).name ?? request.toolCall.name;
      const toolDescription = (request.tool as { description?: string })
        .description;

      // Extract MCP metadata if present (from tools loaded via getMcpTools)
      // Stored under __sapiom namespace to avoid conflicts with other libraries
      const mcpMetadata = (
        request.tool as {
          metadata?: { __sapiom?: { mcp?: Record<string, unknown> } };
        }
      ).metadata?.__sapiom?.mcp;

      // Create and authorize tool transaction
      let toolTx: { id: string } | undefined;
      try {
        toolTx = await authorizer.createAndAuthorize({
          requestFacts: {
            source: "langchain-tool",
            version: "v1",
            sdk: { name: SDK_NAME, version: SDK_VERSION },
            request: {
              toolName,
              toolDescription,
              hasArguments: Object.keys(args).length > 0,
              argumentKeys: Object.keys(args),
              timestamp: new Date().toISOString(),
              ...(mcpMetadata && { mcp: mcpMetadata }),
            },
          },
          traceExternalId: traceId,
          agentId,
          agentName,
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
          error,
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
                err,
              );
            });
        }

        return result;
      } catch (error) {
        // Handle MCP 402 Payment Required
        if (isMCPPaymentError(error)) {
          const paymentData = extractPaymentFromMCPError(
            error as Record<string, unknown>,
          );

          // Create and authorize payment transaction
          const paymentTx = await authorizer.createAndAuthorize({
            paymentData: convertX402ToSapiomPayment(paymentData),
            traceExternalId: traceId,
            qualifiers: { parentTxId: toolTx?.id },
          } as unknown as Parameters<typeof authorizer.createAndAuthorize>[0]);

          const paymentAuth = getPaymentAuthFromTransaction(
            paymentTx as unknown as Record<string, unknown>,
          );

          // Retry with payment in args
          const retryRequest = {
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

          return handler(retryRequest as typeof request);
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
                err,
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
