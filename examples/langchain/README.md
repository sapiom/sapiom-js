# LangChain Example

Demonstrates `@sapiom/langchain` - middleware-based integration for LangChain agents with automatic tracking of model and tool calls.

## Setup

```bash
# Install dependencies
npm install

# Copy environment config from examples root
cp ../.env.example .env

# Edit .env with your API keys (requires ANTHROPIC_API_KEY)
```

## Run

```bash
npm start
```

## What This Shows

- Use `createSapiomMiddleware()` with LangChain's `createAgent()`
- All model calls and tool invocations are tracked automatically
- No need to wrap individual tools - middleware handles everything

## Key Code

```typescript
import { createAgent } from "langchain";
import { createSapiomMiddleware } from "@sapiom/langchain";

// Create agent with Sapiom middleware
const agent = createAgent({
  model: "anthropic:claude-3-5-haiku-latest",
  tools: [weatherTool, calculatorTool],
  middleware: [
    createSapiomMiddleware({
      apiKey: process.env.SAPIOM_API_KEY,
      agentName: "my-langchain-agent",
    }),
  ],
});

// Use normally - all calls tracked automatically
const result = await agent.invoke({
  messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
});
```

## Requirements

- `SAPIOM_API_KEY` - Your Sapiom API key
- `ANTHROPIC_API_KEY` - Anthropic API key for Claude models
