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
  const model = options.model ?? "smart";
  return {
    $schema: "https://opencode.ai/config.json",
    model: `sapiom/${model}`,
    enabled_providers: ["sapiom"],
    plugin: [],
    provider: {
      sapiom: {
        npm: "@ai-sdk/openai-compatible",
        name: "Sapiom",
        options: {
          apiKey: options.runtimeToken,
          baseURL: `${base}/llm/v2/openai/v1`,
        },
        models: { [model]: { name: `Sapiom · ${model}` } },
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
