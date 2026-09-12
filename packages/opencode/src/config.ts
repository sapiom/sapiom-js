export interface SapiomOpenCodeConfigOptions {
  bridgeUrl: string;
  runtimeToken: string;
  model?: string;
}

/** Only a revocable runtime credential enters OpenCode; Studio holds the key. */
export function createSapiomOpenCodeConfig(
  options: SapiomOpenCodeConfigOptions,
): Record<string, unknown> {
  const bridge = new URL(options.bridgeUrl);
  if (
    bridge.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(bridge.hostname) ||
    bridge.username ||
    bridge.password ||
    bridge.search ||
    bridge.hash ||
    !options.runtimeToken
  ) {
    throw new Error("OpenCode requires a private loopback credential bridge");
  }
  const base = bridge.href.replace(/\/+$/, "");
  const model = options.model ?? "gpt-luna";
  return {
    $schema: "https://opencode.ai/config.json",
    model: `sapiom/${model}`,
    enabled_providers: ["sapiom"],
    plugin: [],
    agent: {
      "sapiom-final-response": {
        mode: "primary",
        hidden: true,
        permission: { "*": "deny" },
        prompt:
          "Write the final answer using the existing conversation and completed tool results. Do not perform additional work. Explain any limitations plainly.",
      },
      // Inherits native coding instructions and default permissions. Unlike the
      // old summary-only agent, this can finish the user's remaining work.
      "sapiom-turn-recovery": { mode: "primary", hidden: true },
    },
    provider: {
      sapiom: {
        npm: "@ai-sdk/openai",
        name: "Sapiom",
        options: {
          apiKey: options.runtimeToken,
          baseURL: `${base}/llm/v1`,
        },
        models: {
          [model]: {
            name: `Sapiom · ${model}`,
            limit: { context: 400_000, output: 128_000 },
            options: {
              reasoningEffort: "low",
              reasoningSummary: "auto",
              // Carry reasoning with the conversation through Studio's saved
              // history; never depend on a vendor-side previous_response_id.
              store: false,
              include: ["reasoning.encrypted_content"],
            },
          },
        },
      },
    },
    mcp: {
      sapiom: {
        type: "remote",
        url: `${base}/mcp`,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${options.runtimeToken}` },
      },
    },
  };
}
