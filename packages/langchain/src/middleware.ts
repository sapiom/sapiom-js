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

import { createMiddleware } from "langchain";
import type { AgentMiddleware, ToolCallRequest } from "langchain";

import type {
  SapiomMiddlewareConfig,
  SapiomMiddlewareContext,
} from "./internal/types.js";
import {
  errorClassName,
  providerFromModelClass,
  trackModelCall,
  trackToolCall,
} from "./internal/analytics.js";
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
 * Wrap a model handler with metadata-only analytics (`model.call`).
 *
 * PRIVACY: only scalar metadata (model id, provider, duration, token counts,
 * status, error class) crosses into the event — the allow-list builder in
 * `internal/analytics.ts` is the sole payload constructor. Prompts,
 * completions, and messages never do. Emission is a synchronous enqueue that
 * never throws; the wrapped handler's result and errors pass through
 * untouched.
 */
function withModelCallAnalytics<TRequest, TResult>(
  handler: (request: TRequest) => TResult | Promise<TResult>,
  meta: { model?: string; provider?: string },
): (request: TRequest) => Promise<TResult> {
  return async (request: TRequest): Promise<TResult> => {
    const startedAt = Date.now();
    try {
      const result = await handler(request);
      const tokens = extractActualTokens(result);
      trackModelCall({
        status: "success",
        durationMs: Date.now() - startedAt,
        model: meta.model,
        provider: meta.provider,
        inputTokens: tokens?.promptTokens,
        outputTokens: tokens?.completionTokens,
        totalTokens: tokens?.totalTokens,
      });
      return result;
    } catch (error) {
      trackModelCall({
        status: "error",
        durationMs: Date.now() - startedAt,
        model: meta.model,
        provider: meta.provider,
        errorClass: errorClassName(error),
      });
      throw error;
    }
  };
}

/**
 * Wrap a tool handler with metadata-only analytics (`tool.call`).
 *
 * PRIVACY: only the tool NAME, duration, status, and error class cross into
 * the event — never arguments, results, schemas, or descriptions. Emission
 * is a synchronous enqueue that never throws; the wrapped handler's result
 * and errors pass through untouched.
 */
function withToolCallAnalytics<TRequest, TResult>(
  handler: (request: TRequest) => TResult | Promise<TResult>,
  toolName: string | undefined,
): (request: TRequest) => Promise<TResult> {
  return async (request: TRequest): Promise<TResult> => {
    const startedAt = Date.now();
    try {
      const result = await handler(request);
      trackToolCall({
        status: "success",
        durationMs: Date.now() - startedAt,
        toolName,
      });
      return result;
    } catch (error) {
      trackToolCall({
        status: "error",
        durationMs: Date.now() - startedAt,
        toolName,
        errorClass: errorClassName(error),
      });
      throw error;
    }
  };
}

/**
 * The middleware keeps its trace/transaction bookkeeping on the agent state
 * under `__sapiom*` keys (see {@link SapiomMiddlewareState}). langchain 1.5
 * types middleware state updates against the built-in channels only, so the
 * custom keys are threaded through an opaque cast — runtime behavior (state
 * merging) is unchanged.
 */
function asSapiomStateUpdate(update: Record<string, unknown>): never {
  return update as never;
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

  return createMiddleware({
    name: "SapiomMiddleware",

    // ================================================================
    // AGENT LIFECYCLE: beforeAgent
    // ================================================================
    beforeAgent: async (state, runtime) => {
      if (!isEnabled) {
        return {};
      }

      const startTime = Date.now();
      const context = ((runtime as { context?: unknown }).context ??
        {}) as SapiomMiddlewareContext;

      // Resolve trace ID: context override > config > auto-generate
      const traceId =
        context.sapiomTraceId ?? config.traceId ?? generateSDKTraceId();

      // Resolve agent identity
      const agentId = context.sapiomAgentId ?? config.agentId;
      const agentName = context.sapiomAgentName ?? config.agentName;

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

        return asSapiomStateUpdate({
          __sapiomTraceId: traceId,
          __sapiomAgentTxId: agentTx.id,
          __sapiomStartTime: startTime,
          __sapiomAgentId: agentId,
          __sapiomAgentName: agentName,
        });
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
        return asSapiomStateUpdate({
          __sapiomTraceId: traceId,
          __sapiomStartTime: startTime,
          __sapiomAgentId: agentId,
          __sapiomAgentName: agentName,
        });
      }
    },

    // ================================================================
    // AGENT LIFECYCLE: afterAgent
    // ================================================================
    afterAgent: async (state, _runtime) => {
      const sapiomState = state as Record<string, unknown>;
      if (!isEnabled || !sapiomState.__sapiomAgentTxId) {
        return;
      }

      const txId = sapiomState.__sapiomAgentTxId as string;

      // Clear the transaction ID immediately to prevent double-completion
      // (ReAct agents may loop and call afterAgent multiple times)
      delete sapiomState.__sapiomAgentTxId;

      const duration = sapiomState.__sapiomStartTime
        ? Date.now() - (sapiomState.__sapiomStartTime as number)
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

      // Metadata-only usage analytics around the actual model invocation
      // (never prompts, completions, or messages — see internal/analytics.ts)
      const modelId = getModelId(request.model);
      const modelClass = getModelClass(request.model);
      const callModel = withModelCallAnalytics(handler, {
        model: modelId,
        provider: providerFromModelClass(modelClass),
      });

      const startTime = Date.now();
      const sapiomState = request.state as Record<string, unknown>;
      // Use state trace ID if available, otherwise fall back to middleware-level ID
      const traceId =
        (sapiomState.__sapiomTraceId as string | undefined) ?? fallbackTraceId;
      const agentId =
        (sapiomState.__sapiomAgentId as string | undefined) ?? config.agentId;
      const agentName =
        (sapiomState.__sapiomAgentName as string | undefined) ??
        config.agentName;

      // Collect telemetry
      const estimatedTokens = estimateInputTokens(request.messages);
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
        return callModel(request);
      }

      // Execute model call
      const result = await callModel(request);
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
      const sapiomState = request.state as Record<string, unknown>;
      // Use state trace ID if available, otherwise fall back to middleware-level ID
      const traceId =
        (sapiomState.__sapiomTraceId as string | undefined) ?? fallbackTraceId;
      const agentId =
        (sapiomState.__sapiomAgentId as string | undefined) ?? config.agentId;
      const agentName =
        (sapiomState.__sapiomAgentName as string | undefined) ??
        config.agentName;
      const args = request.toolCall.args ?? {};

      // Get tool name and description safely (works for both ClientTool and ServerTool)
      const toolName =
        (request.tool as { name?: string }).name ?? request.toolCall.name;
      const toolDescription = (request.tool as { description?: string })
        .description;

      // Metadata-only usage analytics around each actual tool invocation
      // (tool NAME only — never args or results; see internal/analytics.ts)
      const callTool = withToolCallAnalytics(handler, toolName);

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
        return callTool(request);
      }

      // Execute tool call with payment retry handling
      try {
        const result = await callTool(request);
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

          return callTool(retryRequest as typeof request);
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
  }) as AgentMiddleware;
}

// Re-export types
export type { SapiomMiddlewareConfig, SapiomMiddlewareContext };
