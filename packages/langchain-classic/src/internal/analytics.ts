/**
 * Metadata-only usage analytics for the LangChain v0.x (classic) wrappers.
 *
 * PRIVACY BOUNDARY — READ BEFORE EDITING.
 *
 * The Sapiom wrappers intercept calls to arbitrary user models and tools
 * whose prompts, completions, messages, arguments, and results never
 * otherwise touch Sapiom. None of that content may ever appear in an
 * analytics payload. This is enforced STRUCTURALLY, not with a redaction
 * filter:
 *
 * - Event payloads are produced exclusively by the allow-list builders in
 *   this module ({@link buildModelCallData} / {@link buildToolCallData}).
 * - The builders accept a closed struct of scalar metadata and copy each
 *   known field one by one, validating its primitive type and capping its
 *   length. Unknown fields cannot pass through; objects are never spread,
 *   serialized, or forwarded.
 * - The instrumentation wrappers ({@link withToolCallAnalytics} /
 *   {@link withModelCallAnalytics}) treat wrapped inputs and outputs as
 *   opaque values: the only thing ever read from a model result is its
 *   token-usage metadata, and nothing at all is read from tool arguments
 *   or results.
 * - For errors, only the constructor name crosses the boundary
 *   ({@link errorClassName}) — never `error.message`, which can embed user
 *   content.
 *
 * Emission is enqueue-only (`track()` is synchronous and never throws) and
 * live by default: an unconfigured emitter delivers to the hosted Sapiom
 * collector. Use `SAPIOM_ANALYTICS_ENDPOINT` to redirect (test use).
 * Opt-outs: `SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
 */
import type { LLMResult } from "@langchain/core/outputs";

import { createAnalytics, type SapiomAnalytics } from "@sapiom/analytics-core";

import { extractActualTokens } from "./token-estimation.js";

/** Emitting package, reported in every envelope. */
const ANALYTICS_SDK_NAME = "@sapiom/langchain-classic";

/**
 * SDK version for envelopes. Keep in sync with package.json on release.
 * TODO: Read from package.json at build time (a plain resolveJsonModule
 * import is not viable here: package.json sits outside rootDir and would
 * reshape the dist/ layout).
 */
const ANALYTICS_SDK_VERSION = "0.4.1";

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
  /** Statically known provider for the wrapper (e.g. "openai"). */
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
      sdkName: ANALYTICS_SDK_NAME,
      sdkVersion: ANALYTICS_SDK_VERSION,
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

/**
 * Wrap a tool implementation with metadata-only analytics (`tool.call`).
 *
 * The wrapped function's arguments and result are treated as opaque values —
 * they are forwarded untouched and never read. Only the tool NAME, duration,
 * status, and error class are emitted. Emission is a synchronous enqueue
 * that never throws; results and errors pass through unchanged.
 */
export function withToolCallAnalytics<TArgs extends unknown[], TResult>(
  toolName: string | undefined,
  fn: (...args: TArgs) => TResult | Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    const startedAt = Date.now();
    try {
      const result = await fn(...args);
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
 * Run one underlying model invocation with metadata-only analytics
 * (`model.call`).
 *
 * The only thing read from the result is token-usage metadata (aggregated
 * across generations); prompts and completions are never touched. Emission
 * is a synchronous enqueue that never throws; results and errors pass
 * through unchanged.
 */
export async function withModelCallAnalytics<TResult extends LLMResult>(
  meta: { model?: string; provider?: string },
  call: () => Promise<TResult>,
): Promise<TResult> {
  const startedAt = Date.now();
  try {
    const result = await call();
    const tokens = aggregateTokenUsage(result);
    trackModelCall({
      status: "success",
      durationMs: Date.now() - startedAt,
      model: meta.model,
      provider: meta.provider,
      inputTokens: tokens?.inputTokens,
      outputTokens: tokens?.outputTokens,
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
}

/**
 * Sum token usage across all generations of an LLMResult. Reads usage
 * metadata only. Returns undefined when no generation reported usage.
 */
function aggregateTokenUsage(
  result: LLMResult,
):
  | { inputTokens: number; outputTokens: number; totalTokens: number }
  | undefined {
  try {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let found = false;

    for (const generation of result.generations ?? []) {
      const message = (generation?.[0] as { message?: unknown } | undefined)
        ?.message;
      if (!message) continue;
      const usage = extractActualTokens(message as never);
      if (!usage) continue;
      found = true;
      inputTokens += usage.promptTokens;
      outputTokens += usage.completionTokens || 0;
      totalTokens += usage.totalTokens || 0;
    }

    return found ? { inputTokens, outputTokens, totalTokens } : undefined;
  } catch {
    return undefined;
  }
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
