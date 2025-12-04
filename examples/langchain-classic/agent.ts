/**
 * LangChain Demo Agent
 *
 * Uses createSapiomReactAgent for full trace support
 *
 * This example uses Anthropic. To use OpenAI instead:
 * 1. npm install @langchain/openai
 * 2. import { ChatOpenAI } from "@langchain/openai"
 * 3. Replace ChatAnthropic with: new ChatOpenAI({ model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY })
 * 4. Set OPENAI_API_KEY in your .env instead of ANTHROPIC_API_KEY
 */
import { ChatAnthropic } from "@langchain/anthropic";
import {
  SapiomClient,
  createSapiomReactAgent,
} from "@sapiom/langchain-classic";

import { createCalculatorTool } from "./tools/sapiom-calculator";
import { createWeatherTool } from "./tools/wrapped-weather";

export interface CreateLangChainDemoAgentConfig {
  sapiomClient: SapiomClient;
  anthropicApiKey: string;
  traceId?: string;
  agentId?: string;
  agentName?: string;
}

/**
 * Create demo agent with Sapiom tracking
 */
export async function createLangChainDemoAgent(
  config: CreateLangChainDemoAgentConfig
) {
  console.log("  Creating LangChain agent with Sapiom tracking...\n");

  const model = new ChatAnthropic({
    model: "claude-3-5-haiku-latest",
    anthropicApiKey: config.anthropicApiKey,
  });

  // Create wrapped tools
  const weatherTool = createWeatherTool(config.sapiomClient);
  const calculatorTool = createCalculatorTool(config.sapiomClient);

  const sapiomAgent = await createSapiomReactAgent(
    {
      llm: model,
      tools: [weatherTool, calculatorTool],
    },
    {
      sapiomClient: config.sapiomClient,
      traceId: config.traceId,
      agentId: config.agentId,
      agentName: config.agentName,
    }
  );

  console.log("  ✓ Agent wrapped with full trace support");
  console.log("    Trace ID: demo-agent-workflow");
  console.log("    All operations (model + tools) grouped under same trace\n");

  return {
    agent: sapiomAgent,
    sapiomClient: config.sapiomClient,
    tools: [weatherTool, calculatorTool],
  };
}

/**
 * Run agent
 */
export async function runLangChainAgent(
  agentWrapper: { agent: any; sapiomClient: SapiomClient },
  query: string,
  sessionId: string
) {
  console.log(`  Query: "${query}"\n`);

  const result = await agentWrapper.agent.invoke({
    messages: [{ role: "user", content: query }],
  });

  return result;
}
