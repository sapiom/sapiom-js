/**
 * SapiomChatAnthropic - Drop-in replacement for ChatAnthropic with Sapiom tracking
 *
 * This follows the same pattern as SapiomChatOpenAI with:
 * - Trace-based workflow grouping
 * - TransactionAuthorizer for pre-execution authorization
 * - Facts-based tracking (backend infers service/action/resource and calculates costs)
 */
import {
  type AnthropicInput,
  type ChatAnthropicCallOptions,
  ChatAnthropicMessages,
} from "@langchain/anthropic";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { BaseMessageLike } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";

import { TransactionAuthorizer } from "@sapiom/core";
import { SapiomClient } from "@sapiom/core";
import { captureUserCallSite, getRuntimeInfo } from "@sapiom/core";
import { initializeSapiomClient } from "@sapiom/core";
import {
  collectDependencyVersions,
  detectEntryMethod,
} from "../internal/langchain-telemetry";
import {
  estimateInputTokens,
  extractActualTokens,
} from "../internal/token-estimation";
import type { SapiomModelConfig } from "../internal/types";
import { generateSDKTraceId } from "../internal/utils";
import type { LangChainLLMRequestFacts } from "../schemas/langchain-llm-v1";

// SDK version for facts
const SDK_VERSION = "1.0.0"; // TODO: Read from package.json

/**
 * Extended ChatAnthropic with built-in Sapiom transaction tracking and authorization
 *
 * Drop-in replacement for ChatAnthropic that adds:
 * - Token estimation and tracking
 * - Pre-execution authorization
 * - Trace-based workflow grouping
 * - Real-time usage reporting
 *
 * @example
 * ```typescript
 * import { SapiomChatAnthropic } from "@sapiom/sdk/langchain";
 *
 * const model = new SapiomChatAnthropic(
 *   {
 *     model: "claude-3-5-sonnet-20241022",
 *     anthropicApiKey: process.env.ANTHROPIC_API_KEY,
 *   },
 *   {
 *     traceId: "conversation-123",
 *     onAfterGenerate: (txId, tokens, cost) => {
 *       console.log(`Used ${tokens} tokens, cost: $${cost}`);
 *     }
 *   }
 * );
 *
 * // All ChatAnthropic methods work, but with Sapiom tracking
 * const response = await model.invoke("Hello!");
 * ```
 */
export class SapiomChatAnthropic<
  CallOptions extends ChatAnthropicCallOptions = ChatAnthropicCallOptions,
> extends ChatAnthropicMessages<CallOptions> {
  protected sapiomClient: SapiomClient;
  protected sapiomConfig: SapiomModelConfig;
  #defaultTraceId: string; // Auto-generated or from config
  #currentTraceId: string; // Updated after each invoke
  #defaultAgentId?: string; // From config
  #defaultAgentName?: string; // From config

  /**
   * Create a new SapiomChatAnthropic instance
   *
   * @param fields - ChatAnthropic configuration (same as ChatAnthropic constructor)
   * @param sapiomConfig - Sapiom-specific configuration
   */
  constructor(
    protected fields?: Partial<AnthropicInput>,
    sapiomConfig?: SapiomModelConfig,
  ) {
    // Call ChatAnthropicMessages constructor with original config
    super(fields);

    // Initialize Sapiom tracking
    this.sapiomClient = initializeSapiomClient(sapiomConfig);
    this.sapiomConfig = sapiomConfig || {};

    // Initialize trace ID - use provided or auto-generate
    this.#defaultTraceId = sapiomConfig?.traceId || generateSDKTraceId();
    this.#currentTraceId = this.#defaultTraceId;

    // Initialize agent config
    this.#defaultAgentId = sapiomConfig?.agentId;
    this.#defaultAgentName = sapiomConfig?.agentName;
  }

  // ============================================
  // NOTE: We do NOT override invoke()
  // ============================================
  // invoke() in BaseChatModel calls generatePrompt() which calls generate()
  // So we only need to override generate() to track all LLM calls
  // This works for both:
  // - model.invoke() → BaseChatModel.invoke() → this.generate() (1 batch)
  // - model.generate([b1, b2]) → this.generate() (2 batches)

  // ============================================
  // OVERRIDE: generate (single override for all LLM calls)
  // ============================================
  // This handles both:
  // - model.invoke() → BaseChatModel.invoke() → this.generate() (1 batch)
  // - model.generate([b1, b2]) → this.generate() (2 batches)
  override async generate(
    messages: BaseMessageLike[][],
    options?: string[] | CallOptions,
    callbacks?: Callbacks,
  ): Promise<LLMResult> {
    const parsedOptions = Array.isArray(options)
      ? ({ stop: options } as CallOptions)
      : options;
    const startTime = Date.now();

    // Check if Sapiom is disabled (either from config or parent metadata)
    const parentEnabled = parsedOptions?.metadata?.__sapiomEnabled;
    const isEnabled = this.sapiomConfig?.enabled !== false;
    if (parentEnabled === false || !isEnabled) {
      // Call parent generate without Sapiom tracking
      return await super.generate(messages, options, callbacks);
    }

    // Resolve trace ID with priority order
    const traceId: string =
      (parsedOptions?.metadata?.__sapiomTraceId as string | undefined) || // Per-invoke override
      this.#defaultTraceId; // Config or auto-generated

    // Resolve agent ID and name with priority order
    const agentId: string | undefined =
      (parsedOptions?.metadata?.__sapiomAgentId as string | undefined) || // Per-invoke override
      this.#defaultAgentId; // From config

    const agentName: string | undefined =
      (parsedOptions?.metadata?.__sapiomAgentName as string | undefined) || // Per-invoke override
      this.#defaultAgentName; // From config

    // Resolve failure mode
    const failureMode =
      (parsedOptions?.metadata?.__sapiomFailureMode as string) ||
      this.sapiomConfig?.failureMode ||
      "open";

    // Use shared authorizer from agent if available, otherwise create inline
    const authorizer =
      (parsedOptions?.metadata?.__sapiomAuthorizer as any) ||
      new TransactionAuthorizer({
        sapiomClient: this.sapiomClient,
      });

    // ============================================
    // STEP 1: Collect Request Facts
    // ============================================

    // Estimate tokens for ALL prompts in the batch
    const tokenEstimates = await Promise.all(
      messages.map(async (msgBatch) => {
        const batchMessages = msgBatch as any[];
        return {
          tokens: await estimateInputTokens(batchMessages, this),
          messageCount: batchMessages.length,
        };
      }),
    );

    const totalEstimatedTokens = tokenEstimates.reduce(
      (sum, est) => sum + est.tokens,
      0,
    );

    // Capture telemetry
    const callSite = captureUserCallSite();
    const entryMethod = detectEntryMethod();
    const runtime = getRuntimeInfo();
    const dependencies = collectDependencyVersions();

    // Build request facts
    const requestFacts: LangChainLLMRequestFacts = {
      framework: "langchain",
      modelClass: this.constructor.name,
      modelId: (this as any).model || (this as any).modelName || "unknown",

      entryMethod,
      isStreaming: false,
      batchSize: messages.length,

      callSite,

      estimatedInputTokens: totalEstimatedTokens,
      tokenEstimationMethod: "tiktoken",

      // Generation parameters
      temperature: (this as any).temperature,
      maxTokens: (this as any).maxTokens,
      topP: (this as any).topP,
      stopSequences: (this as any).stopSequences,

      // Tool usage
      tools: parsedOptions?.tools
        ? {
            enabled: true,
            count: Array.isArray(parsedOptions.tools)
              ? parsedOptions.tools.length
              : 0,
            names: Array.isArray(parsedOptions.tools)
              ? parsedOptions.tools
                  .map((t: any) => t.name || t.function?.name)
                  .filter(Boolean)
              : [],
            toolChoice: parsedOptions?.tool_choice as string,
          }
        : undefined,

      // Structured output (Anthropic uses different pattern than OpenAI)
      structuredOutput: undefined, // TODO: Detect Anthropic structured output

      // Message context
      messages: {
        count: messages[0]?.length || 0,
        hasSystemMessage:
          messages[0]?.some((m: any) => m.role === "system") || false,
        hasImages: false, // TODO: Detect image content
        totalCharacters:
          messages[0]?.reduce(
            (sum: number, m: any) => sum + (m.content?.length || 0),
            0,
          ) || 0,
      },

      // LangChain context
      langchain: parsedOptions?.metadata
        ? {
            runName: parsedOptions.metadata.ls_run_name as string,
            tags: parsedOptions.metadata.ls_tags as string[],
            hasCallbacks: !!callbacks,
            callbackCount: Array.isArray(callbacks) ? callbacks.length : 0,
          }
        : undefined,

      timestamp: new Date().toISOString(),
    };

    // ============================================
    // STEP 2: Create Transaction with Request Facts
    // ============================================
    let tx;
    try {
      tx = await authorizer.createAndAuthorize({
        // NEW: Send request facts (backend infers service/action/resource and calculates cost)
        requestFacts: {
          source: "langchain-llm",
          version: "v1",
          sdk: {
            name: "@sapiom/sdk",
            version: SDK_VERSION,
            nodeVersion: runtime.nodeVersion,
            platform: runtime.platform,
            dependencies,
          },
          request: requestFacts,
        },

        // Allow config overrides (for advanced users)
        serviceName: this.sapiomConfig?.serviceName,

        // Trace still works the same
        traceExternalId: traceId,

        // Agent tagging
        agentId,
        agentName,

        // User-facing metadata and qualifiers (optional)
        qualifiers: parsedOptions?.metadata?.qualifiers,
        metadata: parsedOptions?.metadata?.userMetadata,
      } as any); // TODO: Update TransactionAuthorizer types
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
        "[Sapiom] Failed to create/authorize LLM transaction, continuing without tracking:",
        error,
      );
      // Continue without Sapiom tracking
      return await super.generate(messages, options, callbacks);
    }

    // Update current trace ID from transaction response
    if (tx.trace) {
      this.#currentTraceId = (tx.trace.externalId ?? traceId) as string;
    }

    // ============================================
    // STEP 3: Execute the actual LLM call
    // ============================================
    const result = await super.generate(messages, options, callbacks);
    const duration = Date.now() - startTime;

    // ============================================
    // STEP 4: Submit Response Facts (fire-and-forget)
    // ============================================
    try {
      // Extract actual usage from ALL generations and aggregate
      let totalActualInputTokens = 0;
      let totalActualOutputTokens = 0;
      let totalActualTokens = 0;
      let hadToolCalls = false;
      const toolCallNames: string[] = [];

      result.generations.forEach((generation) => {
        if (generation.length > 0 && (generation[0] as any).message) {
          const message = (generation[0] as any).message;
          const actualUsage = extractActualTokens(message);

          if (actualUsage) {
            totalActualInputTokens += actualUsage.promptTokens;
            totalActualOutputTokens += actualUsage.completionTokens || 0;
            totalActualTokens += actualUsage.totalTokens || 0;
          }

          // Check for tool calls
          if (message.tool_calls && message.tool_calls.length > 0) {
            hadToolCalls = true;
            message.tool_calls.forEach((tc: any) => {
              if (tc.name && !toolCallNames.includes(tc.name)) {
                toolCallNames.push(tc.name);
              }
            });
          }
        }
      });

      // Complete transaction with response facts if we have usage data
      if (totalActualInputTokens > 0) {
        const responseMessage = (result.generations[0]?.[0] as any)?.message;

        await this.sapiomClient.transactions.complete(tx.id, {
          outcome: "success",
          responseFacts: {
            source: "langchain-llm",
            version: "v1",
            facts: {
              actualInputTokens: totalActualInputTokens,
              actualOutputTokens: totalActualOutputTokens,
              actualTotalTokens: totalActualTokens,
              finishReason:
                responseMessage?.response_metadata?.stop_reason || "unknown",
              responseId: responseMessage?.id,
              hadToolCalls,
              toolCallCount: hadToolCalls ? toolCallNames.length : 0,
              toolCallNames: hadToolCalls ? toolCallNames : undefined,
              outputCharacters: result.generations[0]?.[0]?.text?.length || 0,
              hadImages: false, // TODO: Detect image output
              durationMs: duration,
            },
          },
        });
      }
    } catch (error) {
      // Log error but don't fail the generate
      console.error("Failed to complete LLM transaction:", error);
    }

    return result;
  }

  // ============================================
  // OPTIONAL: Override withConfig for clarity (NOT strictly required for Anthropic)
  // ============================================
  // Unlike ChatOpenAI which overrides to create new instances with defaultOptions,
  // ChatAnthropicMessages inherits Runnable.withConfig() which wraps in RunnableBinding.
  //
  // We could omit this override entirely since:
  // - super.withConfig(config) wraps THIS instance in RunnableBinding
  // - THIS instance already has all Sapiom tracking (sapiomClient, traceId, etc.)
  // - When RunnableBinding invokes, it delegates to our overridden invoke() ✅
  //
  // We keep this override for consistency with OpenAI pattern and future flexibility.
  override withConfig(config: Partial<CallOptions>): any {
    // Simply delegate to parent's withConfig which creates RunnableBinding({ bound: this, config })
    return super.withConfig(config);
  }

  // ============================================
  // ALL OTHER METHODS INHERITED FROM ChatAnthropicMessages
  // ============================================
  // withStructuredOutput, stream, batch, etc.
  // All work automatically because we extend ChatAnthropicMessages!

  /**
   * Current trace ID being used by this model
   *
   * This is the user's workflow identifier that groups transactions.
   * It can be:
   * - User-provided from config.traceId
   * - Auto-generated by SDK (prefixed with "sdk-")
   * - Updated after each invoke to reflect backend response
   *
   * Use this to capture the trace ID and reuse across model instances.
   */
  get currentTraceId(): string {
    return this.#currentTraceId;
  }

  /**
   * Access the Sapiom client used by this model
   */
  get __sapiomClient(): SapiomClient {
    return this.sapiomClient;
  }

  /**
   * Marker for double-wrap prevention
   */
  get __sapiomWrapped(): true {
    return true;
  }
}

/**
 * Wrap an existing ChatAnthropic instance with Sapiom tracking
 *
 * Convenience function for migrating existing code without changing instantiation.
 * Extracts all configuration from the original model and creates a new Sapiom-tracked instance.
 *
 * @param model - Existing ChatAnthropic instance to wrap
 * @param config - Optional Sapiom-specific configuration
 * @returns New SapiomChatAnthropic instance with same configuration but Sapiom tracking
 *
 * @example
 * ```typescript
 * import { ChatAnthropic } from "@langchain/anthropic";
 * import { wrapChatAnthropic } from "@sapiom/sdk/langchain";
 *
 * // Existing model
 * const model = new ChatAnthropic({ model: "claude-3-5-sonnet-20241022" });
 *
 * // Wrap with Sapiom tracking - one line change
 * const tracked = wrapChatAnthropic(model, {
 *   sapiomApiKey: process.env.SAPIOM_API_KEY,
 *   traceId: "conversation-123"
 * });
 *
 * // All methods work the same, but now tracked
 * await tracked.invoke("Hello!");
 * ```
 */
export function wrapChatAnthropic<
  CallOptions extends ChatAnthropicCallOptions = ChatAnthropicCallOptions,
>(
  model: any, // ChatAnthropic type
  config?: SapiomModelConfig,
): SapiomChatAnthropic<CallOptions> {
  // Prevent double-wrapping
  if (model.__sapiomWrapped) {
    return model as SapiomChatAnthropic<CallOptions>;
  }

  // ChatAnthropic doesn't store constructor fields - reconstruct from public properties
  // Ordered to match libs/providers/langchain-anthropic/src/chat_models.ts constructor
  const fields: any = {
    // API configuration (lines 733-746)
    anthropicApiKey: model.anthropicApiKey || model.apiKey,
    apiKey: model.apiKey,
    anthropicApiUrl: model.apiUrl,

    // Model settings (lines 748-750)
    modelName: model.modelName,
    model: model.model,

    // Advanced options (line 752)
    invocationKwargs: model.invocationKwargs,

    // Generation parameters (lines 754-760)
    topP: model.topP,
    temperature: model.temperature,
    topK: model.topK,
    maxTokens: model.maxTokens,
    stopSequences: model.stopSequences,

    // Streaming (lines 762-763)
    streaming: model.streaming,
    streamUsage: model.streamUsage,

    // Extended features (lines 765-767)
    thinking: model.thinking,
    contextManagement: model.contextManagement,

    // Client options (line 741)
    clientOptions: model.clientOptions,

    // Client factory (lines 769-771)
    createClient: model.createClient,
  };

  // Filter out undefined values
  const cleanFields = Object.fromEntries(
    Object.entries(fields).filter(([_, value]) => value !== undefined),
  );

  // Create new Sapiom-tracked instance with extracted fields
  return new SapiomChatAnthropic<CallOptions>(cleanFields, config);
}
