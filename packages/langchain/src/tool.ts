/**
 * LangChain Tool Wrapper - Dual API
 *
 * Provides two ways to add Sapiom tracking to tools:
 * 1. wrapSapiomTool() - Wraps existing tools by mutating func property
 * 2. sapiomTool() - Factory for creating new Sapiom-tracked tools
 */
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';

import { TransactionAuthorizer } from '@sapiom/core';
import { SapiomClient } from '@sapiom/core';
import { initializeSapiomClient } from '@sapiom/core';
import {
  convertX402ToSapiomPayment,
  extractPaymentFromMCPError,
  getPaymentAuthFromTransaction,
  isMCPPaymentError,
} from './internal/payment-detection';
import { captureUserCallSite } from '@sapiom/core';
import type { SapiomToolConfig } from './internal/types';
import { isAuthorizationDenied } from './internal/utils';
import type { LangChainToolRequestFacts } from './schemas/langchain-tool-v1';

// SDK version for facts
const SDK_VERSION = '1.0.0'; // TODO: Read from package.json

/**
 * Wraps an existing tool by mutating its func property.
 *
 * ⚠️ WARNING: This mutates the original tool. If the same tool
 * instance is used elsewhere, it will have Sapiom tracking there too.
 *
 * Use this when:
 * - Wrapping tools from other libraries (MCP, custom, etc.)
 * - You don't control the tool creation
 * - Mutation is acceptable (most cases)
 *
 * For new tools, prefer `sapiomTool()` factory instead.
 *
 * @param tool - Any LangChain tool with `func` property
 * @param config - Optional Sapiom configuration
 * @returns Same tool instance (mutated) with __sapiomClient marker
 *
 * @example
 * ```typescript
 * import { tool } from "@langchain/core/tools";
 * import { wrapSapiomTool } from "@sapiom/sdk/langchain";
 *
 * const existing = tool(
 *   ({ count }) => sendSMS(count),
 *   { name: "send_sms", schema: z.object({ count: z.number() }) }
 * );
 *
 * const wrapped = wrapSapiomTool(existing, {
 *   serviceName: "twilio",
 *   resourceName: "send_sms"
 * });
 * // Now pre-authorized before each call!
 * ```
 */
export function wrapSapiomTool<T extends StructuredToolInterface>(
  tool: T,
  config?: SapiomToolConfig,
): T & { __sapiomClient: SapiomClient } {
  const sapiomClient = initializeSapiomClient(config);

  // ============================================
  // PREVENT DOUBLE-WRAPPING
  // ============================================
  if ((tool as any).__sapiomWrapped) {
    return tool as T & { __sapiomClient: SapiomClient };
  }

  // ============================================
  // VALIDATE TOOL HAS func PROPERTY
  // ============================================
  if (!('func' in tool) || typeof (tool as any).func !== 'function') {
    console.warn(
      `Tool ${tool.name} doesn't have 'func' property - Sapiom wrapper skipped. ` +
        `Only DynamicTool and DynamicStructuredTool supported.`,
    );
    (tool as any).__sapiomClient = sapiomClient;
    (tool as any).__sapiomWrapped = true;
    return tool as T & { __sapiomClient: SapiomClient };
  }

  // ============================================
  // STORE ORIGINAL func
  // ============================================
  const originalFunc = (tool as any).func.bind(tool);

  // ============================================
  // REPLACE func PROPERTY
  // ============================================
  (tool as any).func = async function (
    args: any,
    runManager?: CallbackManagerForToolRun,
    parentConfig?: RunnableConfig,
  ): Promise<any> {
    const startTime = Date.now();

    // Extract trace and agent config from parent config (set by model/agent)
    const traceId = parentConfig?.metadata?.__sapiomTraceId as string | undefined;
    const agentId = parentConfig?.metadata?.__sapiomAgentId as string | undefined;
    const agentName = parentConfig?.metadata?.__sapiomAgentName as string | undefined;
    const sessionClient = (parentConfig?.metadata?.__sapiomClient as SapiomClient) || sapiomClient;

    // Use shared authorizer from agent if available, otherwise create inline
    const authorizer =
      (parentConfig?.metadata?.__sapiomAuthorizer as any) || new TransactionAuthorizer({ sapiomClient: sessionClient });

    // ============================================
    // Collect Request Facts
    // ============================================
    const callSite = captureUserCallSite();

    const requestFacts: LangChainToolRequestFacts = {
      toolName: tool.name,
      toolDescription: tool.description,
      inputSchema: (tool as any).schema || {},
      callSite,
      hasArguments: args && Object.keys(args).length > 0,
      argumentKeys: args ? Object.keys(args) : [], // Keys only, not values (privacy!)
      timestamp: new Date().toISOString(),
    };

    // ============================================
    // Create and authorize tool transaction with facts
    // ============================================
    const toolTx = await authorizer.createAndAuthorize({
      // NEW: Send request facts (backend infers service/action/resource)
      requestFacts: {
        source: 'langchain-tool',
        version: 'v1',
        sdk: {
          name: '@sapiom/sdk',
          version: SDK_VERSION,
        },
        request: requestFacts,
      },

      // Allow config overrides (for advanced users)
      serviceName: config?.serviceName,
      actionName: config?.actionName,
      resourceName: config?.resourceName,

      traceExternalId: traceId,
      agentId,
      agentName,
      qualifiers: config?.qualifiers,
    } as any);

    config?.onBeforeCall?.(toolTx.id, tool.name, args, traceId);

    try {
      // Call original tool func
      const result = await originalFunc(args, runManager, parentConfig);
      const duration = Date.now() - startTime;

      // Submit response facts (fire-and-forget)
      sessionClient.transactions
        .addFacts(toolTx.id, {
          source: 'langchain-tool',
          version: 'v1',
          factPhase: 'response',
          facts: {
            success: true,
            durationMs: duration,
            hasResult: result !== null && result !== undefined,
            resultType: typeof result,
          },
        })
        .catch((err) => {
          console.error('Failed to submit tool response facts:', err);
        });

      config?.onAfterCall?.(toolTx.id, result);

      return result;
    } catch (error) {
      // ============================================
      // HANDLE MCP PAYMENT ERRORS
      // ============================================
      if (isMCPPaymentError(error)) {
        const paymentData = extractPaymentFromMCPError(error);

        config?.onPaymentRequired?.(toolTx.id, paymentData, tool.name);

        // Create and authorize payment transaction
        const authorizedPaymentTx = await authorizer.createAndAuthorize({
          serviceName: config?.serviceName || 'tool',
          actionName: 'payment',
          resourceName: config?.resourceName || tool.name,
          paymentData: convertX402ToSapiomPayment(paymentData),
          traceExternalId: traceId,
          agentId,
          agentName,
          qualifiers: {
            parentTxId: toolTx.id,
            originalToolCall: tool.name,
          },
        });

        config?.onPaymentAuthorized?.(authorizedPaymentTx.id);

        // Extract payment authorization
        const paymentAuth = getPaymentAuthFromTransaction(authorizedPaymentTx);

        // Retry with payment in _meta
        const argsWithPayment = {
          ...args,
          _meta: {
            ...(args._meta || {}),
            'x402/payment': paymentAuth,
          },
        };

        // Retry original func with payment
        return await originalFunc(argsWithPayment, runManager, parentConfig);
      }

      // Submit error facts (fire-and-forget)
      const duration = Date.now() - startTime;
      sessionClient.transactions
        .addFacts(toolTx.id, {
          source: 'langchain-tool',
          version: 'v1',
          factPhase: 'error',
          facts: {
            errorType: (error as any).constructor?.name || 'Error',
            errorMessage: (error as Error).message,
            isMCPPaymentError: false, // Already handled above
            elapsedMs: duration,
          },
        })
        .catch((err) => {
          console.error('Failed to submit tool error facts:', err);
        });

      // Handle authorization denied
      if (isAuthorizationDenied(error)) {
        config?.onAuthorizationDenied?.(toolTx.id, (error as Error).message);
      }

      throw error;
    }
  };

  (tool as any).__sapiomClient = sapiomClient;
  (tool as any).__sapiomWrapped = true;
  return tool as unknown as T & { __sapiomClient: SapiomClient };
}

// Backwards compatibility alias
export const createSapiomTool = wrapSapiomTool;

/**
 * Extended DynamicStructuredTool with built-in Sapiom tracking.
 *
 * Drop-in replacement for DynamicStructuredTool that includes
 * authorization and payment handling from creation.
 */
export class SapiomDynamicTool<
  SchemaT = any,
  SchemaOutputT = any,
  SchemaInputT = any,
  ToolOutputT = any,
> extends DynamicStructuredTool<SchemaT, SchemaOutputT, SchemaInputT, ToolOutputT> {
  #sapiomClient: SapiomClient;
  #sapiomConfig: SapiomToolConfig;

  constructor(
    fields: {
      name: string;
      description: string;
      schema: SchemaT;
      func: (input: SchemaOutputT, config?: RunnableConfig) => Promise<ToolOutputT> | ToolOutputT;
      responseFormat?: 'content' | 'content_and_artifact';
      returnDirect?: boolean;
    },
    sapiomConfig?: SapiomToolConfig,
  ) {
    const sapiomClient = initializeSapiomClient(sapiomConfig);

    // Store original func
    const originalFunc = fields.func;

    // Create wrapped func with Sapiom tracking
    const wrappedFunc = async (
      args: SchemaOutputT,
      runManager?: CallbackManagerForToolRun,
      parentConfig?: RunnableConfig,
    ): Promise<ToolOutputT> => {
      // Extract trace and agent config from parent config (set by model/agent)
      const traceId = parentConfig?.metadata?.__sapiomTraceId as string | undefined;
      const agentId = parentConfig?.metadata?.__sapiomAgentId as string | undefined;
      const agentName = parentConfig?.metadata?.__sapiomAgentName as string | undefined;
      const sessionClient = (parentConfig?.metadata?.__sapiomClient as SapiomClient) || sapiomClient;

      // Use shared authorizer from agent if available, otherwise create inline
      const authorizer =
        (parentConfig?.metadata?.__sapiomAuthorizer as any) ||
        new TransactionAuthorizer({ sapiomClient: sessionClient });

      // Create and authorize tool transaction
      const toolTx = await authorizer.createAndAuthorize({
        serviceName: sapiomConfig?.serviceName || 'tool',
        actionName: sapiomConfig?.actionName || 'call',
        resourceName: sapiomConfig?.resourceName || fields.name,
        traceExternalId: traceId, // undefined is fine - backend auto-creates trace
        agentId,
        agentName,
        qualifiers: {
          tool: fields.name,
          // DO NOT include args - may contain sensitive data
          // Users can explicitly add safe metadata via sapiomConfig.qualifiers
          ...sapiomConfig?.qualifiers,
        },
      });

      sapiomConfig?.onBeforeCall?.(toolTx.id, fields.name, args, traceId);

      try {
        // Call original func
        const result = await originalFunc(args, parentConfig);

        sapiomConfig?.onAfterCall?.(toolTx.id, result);

        return result;
      } catch (error) {
        // ============================================
        // HANDLE MCP PAYMENT ERRORS
        // ============================================
        if (isMCPPaymentError(error)) {
          const paymentData = extractPaymentFromMCPError(error);

          sapiomConfig?.onPaymentRequired?.(toolTx.id, paymentData, fields.name);

          // Create and authorize payment transaction
          const authorizedPaymentTx = await authorizer.createAndAuthorize({
            serviceName: sapiomConfig?.serviceName || 'tool',
            actionName: 'payment',
            resourceName: sapiomConfig?.resourceName || fields.name,
            paymentData: convertX402ToSapiomPayment(paymentData),
            traceExternalId: traceId,
            agentId,
            agentName,
            qualifiers: {
              parentTxId: toolTx.id,
              originalToolCall: fields.name,
            },
          });

          sapiomConfig?.onPaymentAuthorized?.(authorizedPaymentTx.id);

          // Extract payment authorization
          const paymentAuth = getPaymentAuthFromTransaction(authorizedPaymentTx);

          // Retry with payment
          const argsWithPayment = {
            ...args,
            _meta: {
              ...(args as any)._meta,
              'x402/payment': paymentAuth,
            },
          } as SchemaOutputT;

          return await originalFunc(argsWithPayment, parentConfig);
        }

        throw error;
      }
    };

    // Call parent with wrapped func
    super({
      ...fields,
      func: wrappedFunc as any,
    });

    this.#sapiomClient = sapiomClient;
    this.#sapiomConfig = sapiomConfig || {};
  }

  get __sapiomClient() {
    return this.#sapiomClient;
  }

  get __sapiomWrapped() {
    return true as const;
  }
}

/**
 * Factory function - drop-in replacement for LangChain's tool()
 *
 * Use this when:
 * - Creating new tools with Sapiom from start
 * - Want clean, explicit code
 * - No surprise mutations
 * - Full TypeScript inference
 *
 * @param func - Tool function implementation
 * @param fields - Tool metadata (name, description, schema)
 * @param sapiomConfig - Sapiom configuration
 * @returns SapiomDynamicTool instance
 *
 * @example
 * ```typescript
 * import { sapiomTool } from "@sapiom/sdk/langchain";
 * import { z } from "zod";
 *
 * const weatherTool = sapiomTool(
 *   async ({ city }) => {
 *     const weather = await getWeather(city);
 *     return `Weather in ${city}: ${weather}`;
 *   },
 *   {
 *     name: "get_weather",
 *     description: "Get current weather for a city",
 *     schema: z.object({
 *       city: z.string().describe("City name"),
 *     }),
 *   },
 *   {
 *     serviceName: "weather-api",
 *     resourceName: "current_weather",
 *   }
 * );
 * ```
 */
export function sapiomTool<SchemaT = any, SchemaOutputT = any, ToolOutputT = any>(
  func: (input: SchemaOutputT, config?: RunnableConfig) => Promise<ToolOutputT> | ToolOutputT,
  fields: {
    name: string;
    description: string;
    schema: SchemaT;
    responseFormat?: 'content' | 'content_and_artifact';
    returnDirect?: boolean;
  },
  sapiomConfig?: SapiomToolConfig,
): SapiomDynamicTool<SchemaT, SchemaOutputT, any, ToolOutputT> {
  return new SapiomDynamicTool<SchemaT, SchemaOutputT, any, ToolOutputT>(
    {
      ...fields,
      func,
    },
    sapiomConfig,
  );
}
