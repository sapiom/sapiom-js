export interface SapiomOpenCodeConfigOptions {
  routingLabel: string;
  llmBaseUrl?: string;
  mcpUrl?: string;
  enableMcp?: boolean;
}

export function createSapiomOpenCodeConfig(
  options: SapiomOpenCodeConfigOptions,
): Record<string, unknown> {
  const modelId = options.routingLabel;
  const llmBaseUrl = stripTrailingSlashes(
    options.llmBaseUrl ?? "https://llm.services.sapiom.ai",
  );
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model: `sapiom/${modelId}`,
    plugin: [],
    provider: {
      sapiom: {
        npm: "@ai-sdk/openai-compatible",
        name: "Sapiom",
        options: {
          apiKey: "{env:SAPIOM_API_KEY}",
          baseURL: `${llmBaseUrl}/v2/openai/v1`,
          headers: {
            "x-sapiom-api-key": "{env:SAPIOM_API_KEY}",
            "x-sapiom-model": options.routingLabel,
          },
        },
        models: {
          [modelId]: { name: `Sapiom · ${options.routingLabel}` },
        },
      },
    },
  };

  if (options.enableMcp !== false) {
    config.mcp = {
      sapiom: {
        type: "remote",
        url: options.mcpUrl ?? "https://api.sapiom.ai/v1/mcp",
        enabled: true,
        oauth: false,
        headers: { "x-api-key": "{env:SAPIOM_API_KEY}" },
      },
    };
  }

  return config;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
