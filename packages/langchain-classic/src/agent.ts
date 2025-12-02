/**
 * Sapiom Agent Wrapper
 *
 * Wraps a LangChain StateGraph to inject trace metadata
 * that propagates from model to tools.
 */
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { TransactionAuthorizer } from "@sapiom/core";
import type { SapiomClient } from "@sapiom/core";
import { initializeSapiomClient } from "@sapiom/core";
import type { BaseSapiomIntegrationConfig } from "@sapiom/core";
import { captureUserCallSite } from "@sapiom/core";
import type { SapiomModelConfig } from "./internal/types";
import { generateSDKTraceId } from "./internal/utils";
import { wrapChatAnthropic } from "./models/anthropic";
import { wrapChatOpenAI } from "./models/openai";
import type { LangChainAgentRequestFacts } from "./schemas/langchain-agent-v1";
import { wrapSapiomTool } from "./tool";

// SDK version for facts
const SDK_VERSION = "1.0.0"; // TODO: Read from package.json

/**
 * Configuration for wrapping an agent with Sapiom tracking
 */
export interface WrapSapiomAgentConfig extends BaseSapiomIntegrationConfig {
  /**
   * Workflow trace identifier
   * - Provided: Uses your ID to group all agent operations
   * - Not provided: SDK auto-generates with "sdk-" prefix
   */
  traceId?: string;

  /**
   * Agent identifier (UUID or numeric ID like AG-001)
   * - Uses existing agent
   * - Cannot be used with agentName
   */
  agentId?: string;

  /**
   * Agent name for find-or-create behavior
   * - Creates agent if doesn't exist
   * - Cannot be used with agentId
   */
  agentName?: string;
}

/**
 * Wrap a LangChain agent graph with Sapiom trace tracking
 *
 * This injects trace metadata into the agent's config, ensuring
 * all operations (model + tools) are grouped under one trace.
 *
 * @param graph - Compiled StateGraph from createReactAgent()
 * @param config - Sapiom configuration
 * @returns Wrapped graph with trace support
 *
 * @example
 * ```typescript
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 * import { wrapSapiomAgent, SapiomChatOpenAI, wrapSapiomTool } from "@sapiom/sdk/langchain";
 *
 * // Create wrapped model
 * const model = new SapiomChatOpenAI({ model: "gpt-4" }, { sapiomClient });
 *
 * // Wrap tools
 * const tools = [
 *   wrapSapiomTool(weatherTool, { sapiomClient }),
 *   wrapSapiomTool(calcTool, { sapiomClient })
 * ];
 *
 * // Create vanilla LangChain agent
 * const graph = createReactAgent({ llm: model, tools });
 *
 * // Wrap with Sapiom trace tracking
 * const agent = wrapSapiomAgent(graph, {
 *   sapiomClient,
 *   traceId: "agent-workflow"
 * });
 *
 * // All operations (model + tools) grouped under one trace
 * await agent.invoke({ messages: [{ role: "user", content: "Hello" }] });
 * ```
 */
export function wrapSapiomAgent(
  graph: any,
  config: WrapSapiomAgentConfig,
): any {
  // If Sapiom is disabled, return the original graph unchanged
  if (config.enabled === false) {
    return graph;
  }

  const sapiomClient = initializeSapiomClient(config);
  const traceId = config.traceId || generateSDKTraceId();
  const failureMode = config.failureMode ?? "open";
  const authorizer = new TransactionAuthorizer({ sapiomClient });

  // ============================================
  // STEP 1: Wrap invoke to inject trace metadata
  // ============================================
  const originalInvoke = graph.invoke.bind(graph);

  graph.invoke = async (state: any, options?: any) => {
    const startTime = Date.now();

    // Collect request facts
    const callSite = captureUserCallSite();

    const requestFacts: LangChainAgentRequestFacts = {
      agentType: "react", // Could detect from graph type
      entryMethod: "invoke",
      messageCount: state.messages?.length || 0,
      callSite,
      timestamp: new Date().toISOString(),
    };

    // Create and authorize agent transaction with facts
    let agentTx;
    try {
      agentTx = await authorizer.createAndAuthorize({
        requestFacts: {
          source: "langchain-agent",
          version: "v1",
          sdk: {
            name: "@sapiom/sdk",
            version: SDK_VERSION,
          },
          request: requestFacts,
        },
        traceExternalId: traceId,
        agentId: config.agentId,
        agentName: config.agentName,
      } as any);
    } catch (error) {
      // Always throw authorization denials and timeouts (these are business logic, not failures)
      if (
        error instanceof Error &&
        (error.name === "TransactionDeniedError" ||
          error.name === "TransactionTimeoutError")
      ) {
        throw error;
      }

      // Handle Sapiom API failures according to failureMode
      if (failureMode === "closed") {
        throw error;
      }
      console.error(
        "[Sapiom] Failed to create/authorize agent transaction, continuing without tracking:",
        error,
      );
      // Continue without Sapiom tracking
      return await originalInvoke(state, options);
    }

    // Inject trace, authorizer, and transaction into config
    // Authorizer is shared to avoid creating new instances on every tool call
    // Transaction signals to stream() that we already authorized
    const enrichedConfig = {
      ...options,
      metadata: {
        ...options?.metadata,
        __sapiomTraceId: traceId,
        __sapiomAgentId: config.agentId,
        __sapiomAgentName: config.agentName,
        __sapiomAuthorizer: authorizer, // Share authorizer with model/tools
        __sapiomAgentTxId: agentTx.id,
        __sapiomAgentInvokeTransaction: agentTx, // Signal to stream()
        __sapiomClient: sapiomClient,
        __sapiomEnabled: config.enabled,
        __sapiomFailureMode: failureMode,
      },
    };

    // Call original graph.invoke with enriched config
    // (internally calls stream() with same enrichedConfig)
    try {
      const result = await originalInvoke(state, enrichedConfig);
      const duration = Date.now() - startTime;

      // Complete transaction with response facts (fire-and-forget)
      sapiomClient.transactions
        .complete(agentTx.id, {
          outcome: "success",
          responseFacts: {
            source: "langchain-agent",
            version: "v1",
            facts: {
              success: true,
              durationMs: duration,
              iterations: 0, // TODO: Track from graph state
              hasOutput: !!result,
              outputMessageCount: result?.messages?.length || 0,
            },
          },
        })
        .catch((err) => {
          console.error("Failed to complete agent transaction:", err);
        });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Complete transaction with error facts (fire-and-forget)
      sapiomClient.transactions
        .complete(agentTx.id, {
          outcome: "error",
          responseFacts: {
            source: "langchain-agent",
            version: "v1",
            facts: {
              errorType: (error as any).constructor?.name || "Error",
              errorMessage: (error as Error).message,
              elapsedMs: duration,
              iterationsBeforeError: 0, // TODO: Track from graph state
            },
          },
        })
        .catch((err) => {
          console.error("Failed to complete agent transaction:", err);
        });

      throw error;
    }
  };

  // ============================================
  // STEP 2: Wrap stream to inject trace metadata
  // ============================================
  const originalStream = graph.stream.bind(graph);

  graph.stream = async (state: any, options?: any) => {
    // Check if called from invoke() (which already created transaction)
    const existingTx = options?.metadata?.__sapiomAgentInvokeTransaction;

    let agentTx;
    let enrichedConfig;

    if (existingTx) {
      // Called from invoke() - reuse existing transaction, pass through config
      agentTx = existingTx;
      enrichedConfig = options; // Already enriched by invoke()
    } else {
      // Direct stream() call - create and authorize transaction
      const callSite = captureUserCallSite();

      const requestFacts: LangChainAgentRequestFacts = {
        agentType: "react",
        entryMethod: "stream",
        messageCount: state.messages?.length || 0,
        callSite,
        timestamp: new Date().toISOString(),
      };

      try {
        agentTx = await authorizer.createAndAuthorize({
          requestFacts: {
            source: "langchain-agent",
            version: "v1",
            sdk: {
              name: "@sapiom/sdk",
              version: SDK_VERSION,
            },
            request: requestFacts,
          },
          traceExternalId: traceId,
          agentId: config.agentId,
          agentName: config.agentName,
        } as any);
      } catch (error) {
        // Always throw authorization denials and timeouts (these are business logic, not failures)
        if (
          error instanceof Error &&
          (error.name === "TransactionDeniedError" ||
            error.name === "TransactionTimeoutError")
        ) {
          throw error;
        }

        // Handle Sapiom API failures according to failureMode
        if (failureMode === "closed") {
          throw error;
        }
        console.error(
          "[Sapiom] Failed to create/authorize agent transaction, continuing without tracking:",
          error,
        );
        // Continue without Sapiom tracking
        return await originalStream(state, options);
      }

      // Inject trace and authorizer into config
      enrichedConfig = {
        ...options,
        metadata: {
          ...options?.metadata,
          __sapiomTraceId: traceId,
          __sapiomAgentId: config.agentId,
          __sapiomAgentName: config.agentName,
          __sapiomAuthorizer: authorizer, // Share authorizer
          __sapiomAgentTxId: agentTx.id,
          __sapiomClient: sapiomClient,
          __sapiomEnabled: config.enabled,
          __sapiomFailureMode: failureMode,
        },
      };
    }

    // Call original graph.stream with enriched config
    return originalStream(state, enrichedConfig);
  };

  // ============================================
  // STEP 3: Add helper properties
  // ============================================
  (graph as any).__sapiomClient = sapiomClient;
  (graph as any).__sapiomTraceId = traceId;

  return graph;
}

/**
 * Create a React agent with full Sapiom tracking
 *
 * Drop-in replacement for LangChain's createReactAgent that automatically:
 * - Wraps the model with Sapiom tracking
 * - Wraps all tools with Sapiom tracking
 * - Wraps the agent graph for unified trace support
 *
 * This is the easiest migration path - just rename createReactAgent to createSapiomReactAgent
 * and add Sapiom config.
 *
 * @param params - Standard createReactAgent parameters (llm, tools)
 * @param config - Optional Sapiom-specific configuration
 * @returns Compiled agent graph with full Sapiom tracking
 *
 * @example
 * ```typescript
 * import { createSapiomReactAgent } from "@sapiom/sdk/langchain";
 * import { ChatOpenAI } from "@langchain/openai";
 * import { pull } from "langchain/hub";
 *
 * // Get tools
 * const tools = [...];
 *
 * // Create Sapiom-tracked agent - just one function call
 * const agent = await createSapiomReactAgent(
 *   {
 *     llm: new ChatOpenAI({ model: "gpt-4" }),
 *     tools,
 *   },
 *   {
 *     sapiomApiKey: process.env.SAPIOM_API_KEY,
 *     traceId: "agent-workflow"
 *   }
 * );
 *
 * // All operations (model + tools) are tracked
 * const result = await agent.invoke({
 *   input: "What's the weather in SF?"
 * });
 * ```
 */
export async function createSapiomReactAgent(
  params: {
    llm: any;
    tools: any[];
    [key: string]: any; // Allow any additional createReactAgent params
  },
  config?: SapiomModelConfig,
): Promise<any> {
  // ============================================
  // STEP 1: Wrap the model with Sapiom tracking
  // ============================================
  let wrappedModel = params.llm;

  // Check if already wrapped
  if (!(params.llm as any).__sapiomWrapped) {
    // Detect provider and wrap accordingly
    const modelConstructorName = params.llm.constructor.name;

    if (
      modelConstructorName === "ChatOpenAI" ||
      modelConstructorName.includes("OpenAI")
    ) {
      wrappedModel = wrapChatOpenAI(params.llm, config);
    } else if (
      modelConstructorName === "ChatAnthropic" ||
      modelConstructorName.includes("Anthropic")
    ) {
      wrappedModel = wrapChatAnthropic(params.llm, config);
    } else {
      throw new Error(
        `Unsupported model type: ${modelConstructorName}. ` +
          `Sapiom currently supports ChatOpenAI and ChatAnthropic. ` +
          `Please wrap your model manually or open an issue for support.`,
      );
    }
  }

  // ============================================
  // STEP 2: Wrap all tools with Sapiom tracking
  // ============================================
  const wrappedTools = params.tools.map((tool) => {
    // Check if already wrapped
    if ((tool as any).__sapiomWrapped) {
      return tool;
    }
    return wrapSapiomTool(tool, config);
  });

  // ============================================
  // STEP 3: Create React agent with wrapped components
  // ============================================
  // Extract llm and tools, and pass through any other params
  const { llm, tools, ...otherParams } = params;
  const agent = await createReactAgent({
    llm: wrappedModel,
    tools: wrappedTools,
    ...otherParams,
  });

  // ============================================
  // STEP 4: Wrap the agent graph for unified trace support
  // ============================================
  return wrapSapiomAgent(agent, {
    ...config,
    traceId: config?.traceId || (wrappedModel as any).currentTraceId,
  });
}
