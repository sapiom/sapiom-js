/**
 * SapiomChatOpenAI - Drop-in replacement for ChatOpenAI with Sapiom tracking
 *
 * IMPORTANT FOR FUTURE PROVIDERS:
 * When implementing SapiomChatAnthropic, SapiomChatGoogle, etc., you MUST:
 *
 * 1. Use `protected` (not private) for sapiomClient and sapiomConfig
 * 2. Store `fields` as `protected override` in constructor
 * 3. Override `invoke()` and `generate()` with Sapiom tracking
 * 4. ⚠️ CRITICAL: Override `withConfig()` to return new SapiomChatYourProvider
 *    - Without this, bindTools() creates parent class (ChatOpenAI), losing tracking
 *    - Must reuse `this.sapiomClient` (don't create new instance)
 *    - Must merge `defaultOptions`
 *
 * See: .taskmaster/docs/ADDING-NEW-PROVIDER-GUIDE.md
 */
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { BaseMessageLike } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import type { RunnableConfig } from "@langchain/core/runnables";
import { RunnableBinding } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatOpenAICallOptions } from "@langchain/openai";

import { TransactionAuthorizer } from "@sapiom/core";
import { SapiomClient } from "@sapiom/core";
import { captureUserCallSite, getRuntimeInfo } from "@sapiom/core";
import { initializeSapiomClient } from "@sapiom/core";
import {
  collectDependencyVersions,
  detectEntryMethod,
} from "../internal/langchain-telemetry.js";
import {
  estimateInputTokens,
  extractActualTokens,
} from "../internal/token-estimation.js";
import type { SapiomModelConfig } from "../internal/types.js";
import { generateSDKTraceId } from "../internal/utils.js";
import type { LangChainLLMRequestFacts } from "../schemas/langchain-llm-v1.js";

// SDK version for facts
const SDK_VERSION = "1.0.0"; // TODO: Read from package.json

/**
 * Extended ChatOpenAI with built-in Sapiom transaction tracking and authorization
 *
 * Drop-in replacement for ChatOpenAI that adds:
 * - Token estimation and tracking
 * - Pre-execution authorization
 * - Trace-based workflow grouping
 * - Real-time usage reporting
 *
 * **Trace Support:**
 * - Direct calls: Full trace support ✓
 * - Vanilla agents (createReactAgent): Model traces only, tools get separate traces
 * - SapiomReactAgent: Full trace support across model + tools ✓ (Phase 4)
 *
 * @example
 * ```typescript
 * import { SapiomChatOpenAI } from "@sapiom/langchain-classic";
 *
 * const model = new SapiomChatOpenAI(
 *   {
 *     model: "gpt-4",
 *     openAIApiKey: process.env.OPENAI_API_KEY,
 *   },
 *   {
 *     apiKey: process.env.SAPIOM_API_KEY,
 *     traceId: "conversation-123",
 *   }
 * );
 *
 * // All ChatOpenAI methods work, but with Sapiom tracking
 * const response = await model.invoke("Hello!");
 * ```
 */
export class SapiomChatOpenAI<
  CallOptions extends ChatOpenAICallOptions = ChatOpenAICallOptions,
> extends ChatOpenAI<CallOptions> {
  protected sapiomClient: SapiomClient;
  protected sapiomConfig: SapiomModelConfig;
  #defaultTraceId: string; // Auto-generated or from config
  #currentTraceId: string; // Updated after each invoke
  #defaultAgentId?: string; // From config
  #defaultAgentName?: string; // From config

  /**
   * Create a new SapiomChatOpenAI instance
   *
   * @param fields - ChatOpenAI configuration (same as ChatOpenAI constructor)
   * @param sapiomConfig - Sapiom-specific configuration
   */
  constructor(
    protected override fields?: any,
    sapiomConfig?: SapiomModelConfig,
  ) {
    // Call ChatOpenAI constructor with original config
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
      frequencyPenalty: (this as any).frequencyPenalty,
      presencePenalty: (this as any).presencePenalty,
      stopSequences: (this as any).stopSequences,

      // Tool usage
      tools: this.defaultOptions?.tools
        ? {
            enabled: true,
            count: this.defaultOptions.tools.length,
            names: this.defaultOptions.tools
              .map((t: any) => t.name || t.function?.name)
              .filter(Boolean),
            toolChoice: parsedOptions?.tool_choice as string,
          }
        : undefined,

      // Structured output
      structuredOutput: this.defaultOptions?.response_format
        ? {
            enabled: true,
            method: (this.defaultOptions.response_format as any)?.type,
          }
        : undefined,

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
                responseMessage?.response_metadata?.finish_reason || "unknown",
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
  // ⚠️ CRITICAL: Override withConfig
  // ============================================
  // WHY THIS IS REQUIRED:
  // - LangGraph calls llm.bindTools(tools) which internally calls llm.withConfig({ tools })
  // - Parent's withConfig() would create ChatOpenAI (not SapiomChatOpenAI)
  // - New instance would lose Sapiom tracking
  // - Result: LLM calls not tracked or authorized ❌
  //
  // PATTERN:
  // - Create new instance of THIS class (SapiomChatOpenAI, not parent)
  // - Pass this.fields (stored in constructor)
  // - MUST reuse this.sapiomClient (same instance, not new one)
  // - Merge defaultOptions (standard pattern from parent)
  //
  // Verify the implementation of each provider's withConfig method to determine if it must be overridden!
  // Providers that do not implement withConfig and default to RunnableBinding.withConfig() may not need this override.
  override withConfig(config: Partial<CallOptions>): any {
    const newModel = new SapiomChatOpenAI<CallOptions>(this.fields, {
      ...this.sapiomConfig,
      sapiomClient: this.sapiomClient, // ← MUST reuse same client instance
      traceId: this.#currentTraceId, // ← Preserve current trace ID
      agentId: this.#defaultAgentId, // ← Preserve agent ID
      agentName: this.#defaultAgentName, // ← Preserve agent name
    });
    newModel.defaultOptions = { ...this.defaultOptions, ...config };
    return newModel;
  }

  // ============================================
  // ALL OTHER METHODS INHERITED FROM ChatOpenAI
  // ============================================
  // withStructuredOutput, stream, batch, etc.
  // All work automatically because we extend ChatOpenAI!

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
   *
   * @example
   * ```typescript
   * const model1 = new SapiomChatOpenAI({ model: "gpt-4" });
   * await model1.invoke("Hello");
   *
   * // Capture auto-generated trace
   * const traceId = model1.currentTraceId;
   *
   * // Reuse in another model
   * const model2 = new SapiomChatOpenAI(
   *   { model: "gpt-3.5-turbo" },
   *   { traceId }
   * );
   * ```
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
 * Wrap an existing ChatOpenAI instance with Sapiom tracking
 *
 * Convenience function for migrating existing code without changing instantiation.
 * Extracts all configuration from the original model and creates a new Sapiom-tracked instance.
 *
 * @param model - Existing ChatOpenAI instance to wrap
 * @param config - Optional Sapiom-specific configuration
 * @returns New SapiomChatOpenAI instance with same configuration but Sapiom tracking
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from "@langchain/openai";
 * import { wrapChatOpenAI } from "@sapiom/langchain-classic";
 *
 * // Existing model
 * const model = new ChatOpenAI({ model: "gpt-4" });
 *
 * // Wrap with Sapiom tracking - one line change
 * const tracked = wrapChatOpenAI(model, {
 *   apiKey: process.env.SAPIOM_API_KEY,
 *   traceId: "conversation-123"
 * });
 *
 * // All methods work the same, but now tracked
 * await tracked.invoke("Hello!");
 * ```
 */
export function wrapChatOpenAI<
  CallOptions extends ChatOpenAICallOptions = ChatOpenAICallOptions,
>(
  model: ChatOpenAI<CallOptions>,
  config?: SapiomModelConfig,
): SapiomChatOpenAI<CallOptions> {
  // Prevent double-wrapping
  if ((model as any).__sapiomWrapped) {
    return model as SapiomChatOpenAI<CallOptions>;
  }

  // ChatOpenAI stores constructor fields as protected property
  // Access it directly at runtime (protected is only compile-time check)
  const fields = (model as any).fields || {};

  // Create new Sapiom-tracked instance with exact same fields
  return new SapiomChatOpenAI<CallOptions>(fields, config);
}
