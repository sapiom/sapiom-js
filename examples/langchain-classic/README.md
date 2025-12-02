# LangChain Classic Example

Demonstrates `@sapiom/langchain-classic` - tool wrapper approach for LangChain agents with explicit tool wrapping and agent creation.

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

- Use `wrapSapiomTool()` to wrap existing LangChain tools
- Use `sapiomTool()` to create new tools with built-in tracking
- Use `createSapiomReactAgent()` for agent creation with trace support

## Key Code

```typescript
import {
  SapiomClient,
  createSapiomReactAgent,
  wrapSapiomTool,
  sapiomTool,
} from "@sapiom/langchain-classic";

// Initialize client
const sapiomClient = new SapiomClient({
  apiKey: process.env.SAPIOM_API_KEY,
});

// Option 1: Wrap existing tool
const wrappedTool = wrapSapiomTool(existingTool, { sapiomClient });

// Option 2: Create new tool with tracking
const newTool = sapiomTool(
  async (input) => { /* ... */ },
  { name: "my_tool", schema: z.object({ ... }) },
  { sapiomClient }
);

// Create agent with tracking
const agent = await createSapiomReactAgent(
  { llm: model, tools: [wrappedTool, newTool] },
  { sapiomClient, traceId: "my-trace" }
);
```

## Requirements

- `SAPIOM_API_KEY` - Your Sapiom API key
- `ANTHROPIC_API_KEY` - Anthropic API key for Claude models

## When to Use This vs `@sapiom/langchain`

Use `@sapiom/langchain-classic` when you need:
- Explicit control over which tools are tracked
- Custom callbacks for tool execution (onBeforeCall, onAfterCall)
- Integration with `@langchain/langgraph` prebuilt agents
