/**
 * Metadata-only usage analytics for the LangChain v1.x middleware.
 *
 * PRIVACY BOUNDARY — READ BEFORE EDITING.
 *
 * The Sapiom middleware wraps calls to arbitrary user models and tools whose
 * prompts, completions, messages, arguments, and results never otherwise
 * touch Sapiom. None of that content may ever appear in an analytics
 * payload. This is enforced STRUCTURALLY, not with a redaction filter:
 *
 * - Event payloads are produced exclusively by the allow-list builders in
 *   this module ({@link buildModelCallData} / {@link buildToolCallData}).
 * - The builders accept a closed struct of scalar metadata and copy each
 *   known field one by one, validating its primitive type and capping its
 *   length. Unknown fields cannot pass through; objects are never spread,
 *   serialized, or forwarded.
 * - This module never imports or receives request/response/message types.
 *   Callers must reduce everything to scalars (names, counts, durations,
 *   statuses) before calling in.
 * - For errors, only the constructor name crosses the boundary
 *   ({@link errorClassName}) — never `error.message`, which can embed user
 *   content.
 *
 * Emission is enqueue-only (`track()` is synchronous and never throws) and
 * live by default: an unconfigured emitter delivers to the hosted Sapiom
 * collector. Use `SAPIOM_ANALYTICS_ENDPOINT` to redirect (test use).
 * Opt-outs: `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
 */
import { createAnalytics, type SapiomAnalytics } from "@sapiom/analytics-core";

import { SDK_NAME, SDK_VERSION } from "./utils.js";

/** Canonical event name for one underlying model invocation. */
export const MODEL_CALL_EVENT = "model.call";

/** Canonical event name for one underlying tool invocation. */
export const TOOL_CALL_EVENT = "tool.call";

/**
 * Cap for name-like fields (model ids, provider names, tool names, error
 * class names). Real identifiers are far shorter; the cap is defense in
 * depth against a pathological value smuggling bulk content.
 */
export const MAX_NAME_LENGTH = 256;

export type CallStatus = "success" | "error";

/** Scalar metadata describing one model invocation. Nothing else gets in. */
export interface ModelCallMeta {
  status: CallStatus;
  durationMs: number;
  /** Model identifier (e.g. "gpt-4") — never prompt or completion content. */
  model?: string;
  /** Provider name inferred from the model class (e.g. "openai"). */
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Error constructor name only — never the error message. */
  errorClass?: string;
}

/** Scalar metadata describing one tool invocation. Nothing else gets in. */
export interface ToolCallMeta {
  status: CallStatus;
  durationMs: number;
  /** Tool NAME only — never arguments, results, schemas, or descriptions. */
  toolName?: string;
  /** Error constructor name only — never the error message. */
  errorClass?: string;
  /**
   * True when a pay-gated (x402) bounce happened and the call was retried
   * with payment. Set on BOTH the success event (payment went through and
   * the retry succeeded) and the error event (retry also failed). Keeps
   * friction visible as a field — never as a second event.
   */
  paymentRetried?: boolean;
}

/**
 * Allow-list builder for `model.call` payloads. Copies each known scalar
 * field individually; anything not listed here cannot reach the wire.
 */
export function buildModelCallData(
  meta: ModelCallMeta,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    status: meta.status === "error" ? "error" : "success",
  };
  const durationMs = asDuration(meta.durationMs);
  if (durationMs !== undefined) data.duration_ms = durationMs;
  const model = asName(meta.model);
  if (model !== undefined) data.model = model;
  const provider = asName(meta.provider);
  if (provider !== undefined) data.provider = provider;
  const inputTokens = asCount(meta.inputTokens);
  if (inputTokens !== undefined) data.input_tokens = inputTokens;
  const outputTokens = asCount(meta.outputTokens);
  if (outputTokens !== undefined) data.output_tokens = outputTokens;
  const totalTokens = asCount(meta.totalTokens);
  if (totalTokens !== undefined) data.total_tokens = totalTokens;
  const errorClass = asName(meta.errorClass);
  if (meta.status === "error" && errorClass !== undefined) {
    data.error_class = errorClass;
  }
  return data;
}

/**
 * Allow-list builder for `tool.call` payloads. Copies each known scalar
 * field individually; anything not listed here cannot reach the wire.
 */
export function buildToolCallData(meta: ToolCallMeta): Record<string, unknown> {
  const data: Record<string, unknown> = {
    status: meta.status === "error" ? "error" : "success",
  };
  const durationMs = asDuration(meta.durationMs);
  if (durationMs !== undefined) data.duration_ms = durationMs;
  const toolName = asName(meta.toolName);
  if (toolName !== undefined) data.tool_name = toolName;
  const errorClass = asName(meta.errorClass);
  if (meta.status === "error" && errorClass !== undefined) {
    data.error_class = errorClass;
  }
  if (meta.paymentRetried === true) data.payment_retried = true;
  return data;
}

let instance: SapiomAnalytics | null = null;

/**
 * Lazy singleton emitter. Created on the first tracked event so that
 * consent and endpoint environment variables are read at use time.
 */
export function getAnalytics(): SapiomAnalytics {
  if (instance === null) {
    instance = createAnalytics({
      source: "langchain",
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
    });
  }
  return instance;
}

/**
 * Test-only: drop the singleton so the next event re-reads consent and
 * endpoint configuration. Not part of the public API.
 * @internal
 */
export async function __resetAnalyticsForTests(): Promise<void> {
  const previous = instance;
  instance = null;
  if (previous !== null) await previous.shutdown();
}

/** Enqueue one `model.call` event. Synchronous; never throws. */
export function trackModelCall(meta: ModelCallMeta): void {
  try {
    getAnalytics().track(MODEL_CALL_EVENT, buildModelCallData(meta));
  } catch {
    // Analytics must never affect the wrapped call.
  }
}

/** Enqueue one `tool.call` event. Synchronous; never throws. */
export function trackToolCall(meta: ToolCallMeta): void {
  try {
    getAnalytics().track(TOOL_CALL_EVENT, buildToolCallData(meta));
  } catch {
    // Analytics must never affect the wrapped call.
  }
}

/**
 * The only error detail allowed across the privacy boundary: the constructor
 * name (a code identifier). Never the message, which can embed user content.
 */
export function errorClassName(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.constructor?.name || "Error";
    }
    return "UnknownError";
  } catch {
    return "UnknownError";
  }
}

/** LangChain chat-model class names → provider identifiers. */
const MODEL_CLASS_PROVIDERS: Record<string, string> = {
  ChatAnthropic: "anthropic",
  ChatAnthropicMessages: "anthropic",
  ChatOpenAI: "openai",
  AzureChatOpenAI: "azure_openai",
  ChatGoogleGenerativeAI: "google_genai",
  ChatVertexAI: "google_vertexai",
  ChatCohere: "cohere",
  ChatMistralAI: "mistralai",
  ChatGroq: "groq",
  ChatBedrockConverse: "bedrock",
  ChatOllama: "ollama",
  ChatXAI: "xai",
  ChatDeepSeek: "deepseek",
  ChatFireworks: "fireworks",
  ChatTogetherAI: "togetherai",
};

/**
 * Map a model class name (from `getModelClass`) to a provider identifier.
 * Unmapped class names pass through as-is — they are code identifiers, not
 * user content. `"unknown"` maps to `undefined` so the field is omitted.
 */
export function providerFromModelClass(
  modelClass: string | undefined,
): string | undefined {
  if (!modelClass || modelClass === "unknown") return undefined;
  return MODEL_CLASS_PROVIDERS[modelClass] ?? modelClass;
}

function asName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function asDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function asCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}
