import { createClient } from "@sapiom/tools";

import type {
  ProviderAttempt,
  ProviderRequest,
  ProviderUsage,
} from "../contracts.js";
import {
  REQUESTED_MODEL,
  sanitizeProviderErrorCode,
  type SemanticGraphProvider,
} from "../provider.js";

interface LunaProviderEnvironment {
  RUN_REAL_SEMANTIC_GRAPH_EVAL?: string;
  SAPIOM_API_KEY?: string;
}

export interface SapiomLunaProviderOptions {
  environment?: LunaProviderEnvironment;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface CapturedResponseMetadata {
  status: number | null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function sanitizedDisclosure(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,79}$/.test(value)
    ? value
    : null;
}

function usageFromResponse(
  response: unknown,
  latencyMs: number,
  disclosure: { servedClass: string | null; lane: string | null },
): ProviderUsage {
  const usage =
    typeof response === "object" && response !== null
      ? (response as { usage?: unknown }).usage
      : undefined;
  const record =
    typeof usage === "object" && usage !== null
      ? (usage as Record<string, unknown>)
      : {};
  return {
    inputTokens: tokenCount(record.input_tokens),
    outputTokens: tokenCount(record.output_tokens),
    // The public synchronous LLM response has no authoritative per-call price.
    // Keep the absence explicit rather than guessing an internal header.
    costUsd: null,
    latencyMs,
    servedClass: sanitizedDisclosure(disclosure.servedClass),
    lane: sanitizedDisclosure(disclosure.lane),
  };
}

export function assertRealEvaluationEnabled(
  environment: LunaProviderEnvironment,
): asserts environment is LunaProviderEnvironment & { SAPIOM_API_KEY: string } {
  if (environment.RUN_REAL_SEMANTIC_GRAPH_EVAL !== "1") {
    throw new Error(
      "Luna evaluation is disabled: set RUN_REAL_SEMANTIC_GRAPH_EVAL=1 explicitly",
    );
  }
  if (!environment.SAPIOM_API_KEY?.trim()) {
    throw new Error(
      "Luna evaluation is unavailable: SAPIOM_API_KEY is not set",
    );
  }
}

export class SapiomLunaProvider implements SemanticGraphProvider {
  readonly id = "sapiom-luna" as const;
  private readonly environment: LunaProviderEnvironment;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: SapiomLunaProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async invoke(request: ProviderRequest): Promise<ProviderAttempt> {
    assertRealEvaluationEnabled(this.environment);
    const captured: CapturedResponseMetadata = { status: null };
    const capturingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await this.fetchImpl(input, init);
      captured.status = response.status;
      return response;
    };
    const client = createClient({
      apiKey: this.environment.SAPIOM_API_KEY,
      fetch: capturingFetch,
    });
    const startedAt = this.now();
    try {
      let response: unknown;
      try {
        response = await client.llm.run({
          request: {
            system: request.prompt.system,
            messages: [{ role: "user", content: request.prompt.user }],
            max_tokens: request.configuration.maxOutputTokens,
          },
          model: REQUESTED_MODEL,
          neverFail: false,
          output: {
            name: request.prompt.outputName,
            schema: request.prompt.outputSchema,
          },
        });
      } catch {
        return {
          status: "failure",
          errorCode: sanitizeProviderErrorCode(captured.status),
          latencyMs: Math.max(0, this.now() - startedAt),
          requestedModel: REQUESTED_MODEL,
        };
      }
      const latencyMs = Math.max(0, this.now() - startedAt);
      try {
        const rawResponse: unknown = client.llm.structuredOf(
          response,
          request.prompt.outputName,
        );
        return {
          status: "success",
          rawResponse,
          usage: usageFromResponse(
            response,
            latencyMs,
            client.llm.readDisclosure(response),
          ),
          requestedModel: REQUESTED_MODEL,
        };
      } catch {
        return {
          status: "harness-failure",
          errorCode: "response-normalization-error",
          latencyMs,
          requestedModel: REQUESTED_MODEL,
        };
      }
    } finally {
      await client.shutdown();
    }
  }
}
