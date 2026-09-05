import { describe, expect, it } from "vitest";

import { createSapiomOpenCodeConfig } from "./config.js";

describe("createSapiomOpenCodeConfig", () => {
  it("pins the gateway wire, routing label, credential, and MCP headers", () => {
    expect(
      createSapiomOpenCodeConfig({
        routingLabel: "builder-code",
        llmBaseUrl: "https://llm.example/",
        mcpUrl: "https://api.example/v1/mcp",
      }),
    ).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "sapiom/builder-code",
      plugin: [],
      provider: {
        sapiom: {
          npm: "@ai-sdk/openai-compatible",
          name: "Sapiom",
          options: {
            apiKey: "{env:SAPIOM_API_KEY}",
            baseURL: "https://llm.example/v2/openai/v1",
            headers: {
              "x-sapiom-api-key": "{env:SAPIOM_API_KEY}",
              "x-sapiom-model": "builder-code",
            },
          },
          models: {
            "builder-code": { name: "Sapiom · builder-code" },
          },
        },
      },
      mcp: {
        sapiom: {
          type: "remote",
          url: "https://api.example/v1/mcp",
          enabled: true,
          oauth: false,
          headers: { "x-api-key": "{env:SAPIOM_API_KEY}" },
        },
      },
    });
  });

  it("can omit Sapiom MCP while proving the chat boundary", () => {
    const config = createSapiomOpenCodeConfig({
      routingLabel: "smart",
      enableMcp: false,
    });

    expect(config).not.toHaveProperty("mcp");
  });
});
