import { describe, expect, it } from "vitest";
import {
  codexInferenceConfig,
  inferenceAuthSnapshot,
  inferenceConfigToml,
} from "./codex-inference-profile.js";
import { codexInferenceRestrictions } from "./codex-structured-inference.js";

describe("Codex isolated inference profile", () => {
  it("preserves the default model/provider while removing executable customization and unrelated providers", () => {
    const config = codexInferenceConfig({
      model: "custom-model",
      model_provider: "company.gateway",
      model_reasoning_effort: "high",
      model_providers: {
        "company.gateway": {
          name: "Gateway",
          base_url: "https://example.test",
          env_key: "TEST_KEY",
          wire_api: "responses",
        },
        unrelated: { auth: { command: "bad" } },
      },
      mcp_servers: { danger: { command: "bad" } },
      developer_instructions: "bad",
      notify: ["bad"],
      features: { hooks: true },
      profiles: { unsafe: { mcp_servers: { bad: {} } } },
    });
    expect(config).toMatchObject({
      model: "custom-model",
      model_provider: "company.gateway",
      model_reasoning_effort: "high",
      notify: [],
    });
    expect(config).not.toHaveProperty("mcp_servers");
    expect(config).not.toHaveProperty("features");
    expect(Object.keys(config.model_providers as object)).toEqual([
      "company.gateway",
    ]);
    expect(inferenceConfigToml(config)).toContain('"company.gateway"={');
  });
  it("a worker cannot rotate the original native refresh token", () => {
    const token = `header.${Buffer.from(JSON.stringify({ exp: 10000 })).toString("base64url")}.signature`;
    const raw = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "inactive-native-key",
      tokens: {
        access_token: token,
        refresh_token: "original-refresh",
        id_token: "native-id",
      },
      last_refresh: "native-time",
    };
    const snapshot = inferenceAuthSnapshot(raw, 9000);
    expect(snapshot).toMatchObject({
      tokens: { refresh_token: "", access_token: token },
      last_refresh: "native-time",
    });
    expect(raw.tokens.refresh_token).toBe("original-refresh");
    expect(() => inferenceAuthSnapshot(raw, 9900)).toThrow("needs refresh");
  });
  it("preserves native API authentication without inventing OAuth tokens", () => {
    expect(
      inferenceAuthSnapshot({ OPENAI_API_KEY: "test-only", tokens: null }),
    ).toEqual({ OPENAI_API_KEY: "test-only" });
  });
  it("disables servers with dots in their names, hooks, tools, instructions, and notification commands", () => {
    const restrictions = codexInferenceRestrictions(
      "/private/instructions",
      "Fixed instructions",
      ["server.with.dots"],
    );
    expect(restrictions.mcp_servers).toEqual({
      "server.with.dots": { enabled: false },
    });
    expect(restrictions).toMatchObject({
      notify: [],
      project_doc_max_bytes: 0,
      web_search: "disabled",
      orchestrator: { skills: { enabled: false } },
      features: {
        hooks: false,
        plugins: false,
        shell_tool: false,
        apps: false,
        multi_agent: false,
      },
    });
  });
});
