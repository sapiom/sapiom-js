/**
 * LangChain Classic Demo - Main Entry Point
 *
 * Demonstrates tool wrapper approach for Sapiom LangChain integration:
 * - wrapSapiomTool() for existing tools
 * - sapiomTool() for new tools
 * - Trace tracking across tool calls
 * - Transaction authorization flow
 *
 * Run: npm start
 */
import { SapiomClient } from "@sapiom/langchain-classic";
import dotenv from "dotenv";

import { createLangChainDemoAgent, runLangChainAgent } from "./agent";

dotenv.config();

async function main() {
  console.log("\n" + "═".repeat(70));
  console.log("  Sapiom LangChain Demo - Tool Wrapper Approach");
  console.log("═".repeat(70));
  console.log("\nWhat this demonstrates:");
  console.log("  ✓ wrapSapiomTool() - wrapping existing LangChain tools");
  console.log("  ✓ sapiomTool() - creating new Sapiom-tracked tools");
  console.log("  ✓ Trace tracking across multiple tool calls");
  console.log("  ✓ Transaction authorization before execution");
  console.log("\nPrerequisites:");
  console.log("  ✓ Sapiom backend running (default: http://localhost:3000)");
  console.log("  ✓ SAPIOM_API_KEY environment variable set");
  console.log("  ✓ ANTHROPIC_API_KEY environment variable set");
  console.log("\n" + "─".repeat(70) + "\n");

  // Validate environment
  if (!process.env.SAPIOM_API_KEY) {
    console.error("  SAPIOM_API_KEY environment variable is required");
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("  ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  // Initialize Sapiom client
  const sapiomClient = new SapiomClient({
    apiKey: process.env.SAPIOM_API_KEY,
    baseURL: process.env.SAPIOM_API_URL || "http://localhost:3000",
  });

  console.log("  ✓ Sapiom client initialized\n");

  // Generate unique trace ID for this demo run
  const traceId = `langchain-classic-demo-${Date.now()}`;
  const agentName = `langchain-classic-demo-agent-${Date.now()}`;

  // Create agent
  const agent = await createLangChainDemoAgent({
    sapiomClient,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    traceId: traceId,
    agentName: agentName,
  });

  console.log(`  Trace ID: ${traceId}\n`);
  console.log("─".repeat(70) + "\n");

  try {
    // Scenario 1: Weather query (tests wrapped tool)
    console.log("--- Scenario 1: Weather Query (wrapSapiomTool) ---\n");
    const result1 = await runLangChainAgent(
      agent,
      "What is the weather in Tokyo?",
      traceId
    );
    console.log(
      `\n  Agent response: ${
        result1.messages[result1.messages.length - 1].content
      }\n`
    );
    console.log("─".repeat(70) + "\n");

    // Scenario 2: Math calculation (tests sapiomTool)
    console.log("--- Scenario 2: Math Calculation (sapiomTool) ---\n");
    const result2 = await runLangChainAgent(
      agent,
      "Calculate 42 * 1.5 + 10",
      traceId
    );
    console.log(
      `\n  Agent response: ${
        result2.messages[result2.messages.length - 1].content
      }\n`
    );
    console.log("─".repeat(70) + "\n");

    // Scenario 3: Combined (tests both tools in same trace)
    console.log("--- Scenario 3: Combined Query (both tools) ---\n");
    const result3 = await runLangChainAgent(
      agent,
      "What is the weather in Paris, and calculate 25 * 4?",
      traceId
    );
    console.log(
      `\n  Agent response: ${
        result3.messages[result3.messages.length - 1].content
      }\n`
    );
    console.log("─".repeat(70) + "\n");

    console.log("\n" + "═".repeat(70));
    console.log("  Demo Complete");
    console.log("═".repeat(70));
    console.log(`\n  All tool calls tracked under trace: ${traceId}`);
    console.log("  Check Sapiom dashboard for transaction details.\n");
  } catch (error: any) {
    console.log("\n" + "═".repeat(70));
    console.log("  Demo Failed");
    console.log("═".repeat(70));
    console.error(`\nError: ${error.message}\n`);

    if (error.name === "AuthorizationDeniedError") {
      console.log("  This means Sapiom backend denied a transaction.");
      console.log("  Possible reasons:");
      console.log("    - Budget limit exceeded");
      console.log("    - Tool not allowed");
      console.log("    - Trace limit reached\n");
    } else {
      console.log("  Troubleshooting:");
      console.log("    - Ensure Sapiom backend is running");
      console.log("    - Check SAPIOM_API_KEY is valid");
      console.log("    - Check ANTHROPIC_API_KEY is valid\n");
    }

    console.log("  Full error details:");
    console.error(error);
    console.log("");

    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
