/**
 * Sapiom LangChain Demo
 *
 * Demonstrates @sapiom/langchain middleware integration:
 * - createAgent() with middleware for automatic tracking
 * - Plain LangChain tools (no Sapiom wrappers needed)
 * - All model and tool calls tracked automatically
 *
 * Run: npm start
 */
import { createAgent } from "langchain";
import { createSapiomMiddleware } from "@sapiom/langchain";
import dotenv from "dotenv";

import { weatherTool } from "./tools/weather";
import { calculatorTool } from "./tools/calculator";

dotenv.config();

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  Sapiom SDK Demo: @sapiom/langchain");
  console.log("═".repeat(60));

  console.log("\n  What this demonstrates:");
  console.log("    • createAgent() with Sapiom middleware");
  console.log("    • Automatic tracking of agent lifecycle");
  console.log("    • Automatic tracking of model calls");
  console.log("    • Automatic tracking of tool calls");
  console.log("    • No manual wrapping of tools or models needed");

  console.log("\n  Prerequisites:");
  console.log("    • Sapiom backend running (default: http://localhost:3000)");
  console.log("    • SAPIOM_API_KEY environment variable set");
  console.log("    • ANTHROPIC_API_KEY environment variable set");
  console.log("\n" + "─".repeat(60) + "\n");

  // Validate environment
  if (!process.env.SAPIOM_API_KEY) {
    console.error("  SAPIOM_API_KEY environment variable is required");
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("  ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  // Generate unique trace ID for this demo run
  const traceId = `langchain-demo-${Date.now()}`;

  console.log(`  Trace ID: ${traceId}\n`);

  // Create agent with Sapiom middleware - this is all you need!
  // Using Anthropic here. For OpenAI, change to: model: "openai:gpt-4o-mini"
  // and set OPENAI_API_KEY in your .env instead of ANTHROPIC_API_KEY
  const agent = createAgent({
    model: "anthropic:claude-3-5-haiku-latest",
    tools: [weatherTool, calculatorTool],
    middleware: [
      createSapiomMiddleware({
        apiKey: process.env.SAPIOM_API_KEY,
        baseURL: process.env.SAPIOM_API_URL || "http://localhost:3000",
        traceId,
        agentName: `langchain-demo-agent-${Date.now()}`,
        failureMode: "open",
      }),
    ],
  });

  console.log("  ✓ Agent created with Sapiom middleware\n");
  console.log("─".repeat(60) + "\n");

  try {
    // Scenario 1: Weather query
    console.log("  --- Scenario 1: Weather Query ---\n");
    const result1 = await agent.invoke({
      messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
    });
    console.log(
      `\n  Response: ${result1.messages[result1.messages.length - 1].content}\n`
    );
    console.log("─".repeat(60) + "\n");

    // Scenario 2: Math calculation
    console.log("  --- Scenario 2: Math Calculation ---\n");
    const result2 = await agent.invoke({
      messages: [{ role: "user", content: "Calculate 42 * 1.5 + 10" }],
    });
    console.log(
      `\n  Response: ${result2.messages[result2.messages.length - 1].content}\n`
    );
    console.log("─".repeat(60) + "\n");

    // Scenario 3: Combined query (both tools)
    console.log("  --- Scenario 3: Combined Query (both tools) ---\n");
    const result3 = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "What is the weather in Paris, and calculate 25 * 4?",
        },
      ],
    });
    console.log(
      `\n  Response: ${result3.messages[result3.messages.length - 1].content}\n`
    );
    console.log("─".repeat(60) + "\n");

    console.log("═".repeat(60));
    console.log("  Demo Complete");
    console.log("═".repeat(60));
    console.log(`\n  All operations tracked under trace: ${traceId}`);
    console.log("  Check Sapiom dashboard for transaction details.\n");
  } catch (error: any) {
    console.log("\n" + "═".repeat(60));
    console.log("  Demo Failed");
    console.log("═".repeat(60));
    console.error(`\n  Error: ${error.message}\n`);

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
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
