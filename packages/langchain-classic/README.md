# @sapiom/langchain-classic

[![npm version](https://badge.fury.io/js/%40sapiom%2Flangchain-classic.svg)](https://www.npmjs.com/package/@sapiom/langchain-classic)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Beta Status:** Currently in v0.x. API may change before v1.0.0. Production-ready and actively maintained.

LangChain integration for Sapiom SDK providing automatic cost tracking, authorization, and session management for LangChain agents, tools, and models.

## Version Compatibility

| Package Version | LangChain Version | Status |
|----------------|-------------------|---------|
| v0.x           | v0.3+            | ✅ Active |

This package supports LangChain v0.x. For LangChain v1.x, use [`@sapiom/langchain`](../langchain/README.md) instead.

## Installation

```bash
npm install @sapiom/langchain-classic @langchain/core @langchain/anthropic
# or for OpenAI:
npm install @sapiom/langchain-classic @langchain/core @langchain/openai
```

**Peer dependencies:** This package requires `@langchain/core` and either `@langchain/anthropic` or `@langchain/openai` depending on which model you use.

## Features

- ✅ **One-line integration**: Replace `createReactAgent` with `createSapiomReactAgent`
- ✅ Automatic transaction authorization and cost tracking
- ✅ Trace-based workflow grouping for agents, tools, and models
- ✅ Pre-emptive authorization before LLM calls
- ✅ Automatic payment handling for MCP tools (402 errors)
- ✅ Works with any LangChain model (OpenAI, Anthropic, etc.)
- ✅ Full TypeScript support
- ✅ Environment variable configuration

## Quick Start

The easiest way to add Sapiom tracking to your LangChain agent:

```typescript
import { createSapiomReactAgent } from '@sapiom/langchain-classic';
import { ChatOpenAI } from '@langchain/openai';

// Just replace createReactAgent with createSapiomReactAgent
const agent = await createSapiomReactAgent(
  {
    llm: new ChatOpenAI({ model: 'gpt-4' }),
    tools: [...yourTools]
  },
  {
    apiKey: process.env.SAPIOM_API_KEY,
    traceId: 'my-agent-session'
  }
);

// All operations (model + tools) are automatically tracked
const result = await agent.invoke({
  messages: [{ role: "user", content: "What's the weather?" }]
});
```

That's it! `createSapiomReactAgent` automatically wraps your model and tools with Sapiom tracking.

## Configuration

All Sapiom wrappers (models, tools, agents) support the following configuration options:

```typescript
import { SapiomChatOpenAI, wrapSapiomTool, wrapSapiomAgent } from '@sapiom/langchain-classic';

const config = {
  // Required (or use SAPIOM_API_KEY environment variable)
  apiKey: 'sk_...',

  // Optional - Control
  enabled: true,              // Enable Sapiom handling (default: true)
  failureMode: 'open',        // 'open' | 'closed' (default: 'open')
                              // 'open': Allow operations if Sapiom fails (prioritizes availability)
                              // 'closed': Block operations if Sapiom fails (prioritizes security)

  // Optional - Default metadata (applied to all operations)
  agentName: 'my-agent',      // Agent identifier
  agentId: 'agent-123',       // Agent UUID or numeric ID
  serviceName: 'my-service',  // Service name for transactions
  traceId: 'trace-xyz',       // Workflow trace identifier
  traceExternalId: 'ext-456', // External trace identifier
};

// Apply to models
const model = new SapiomChatOpenAI({ model: 'gpt-4' }, config);

// Apply to tools
const tool = wrapSapiomTool(myTool, config);

// Apply to agents
const agent = wrapSapiomAgent(graph, config);
```

### Control Options

#### `enabled`
When `false`, disables Sapiom tracking entirely. The wrapped component behaves exactly like the original LangChain component.

```typescript
const model = new SapiomChatOpenAI(
  { model: 'gpt-4' },
  { apiKey: 'sk_...', enabled: false }
);
// Behaves like regular ChatOpenAI - no tracking
```

#### `failureMode`
Controls behavior when Sapiom API fails (network errors, 5xx, timeouts, SDK bugs):
- `'open'` (default): Logs error, continues without tracking (prioritizes availability)
- `'closed'`: Throws error, blocks operation (prioritizes security)

**Important:** Authorization denials and timeouts always throw errors regardless of `failureMode` (these are business logic decisions, not system failures).

```typescript
// Development/testing: Fail fast if Sapiom has issues
const model = new SapiomChatOpenAI(
  { model: 'gpt-4' },
  { apiKey: 'sk_...', failureMode: 'closed' }
);

// Production: Degrade gracefully if Sapiom has issues
const model = new SapiomChatOpenAI(
  { model: 'gpt-4' },
  { apiKey: 'sk_...', failureMode: 'open' } // default
);
```

### Per-Request Overrides

Override configuration for individual requests using metadata:

```typescript
// Disable Sapiom for a specific call
await model.invoke("Public data", {
  metadata: { __sapiomEnabled: false }
});

// Override trace ID for a specific call
await model.invoke("User query", {
  metadata: { __sapiomTraceId: "conversation-456" }
});
```

## Usage

### Agents (Recommended)

Use `createSapiomReactAgent` as a drop-in replacement for LangChain's `createReactAgent`. It automatically wraps your model and tools:

```typescript
import { createSapiomReactAgent } from '@sapiom/langchain-classic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';

// Works with any LangChain model
const agent = await createSapiomReactAgent(
  {
    llm: new ChatOpenAI({ model: 'gpt-4' }),
    // or: llm: new ChatAnthropic({ model: 'claude-3-5-sonnet-20241022' }),
    tools: [...yourTools]
  },
  {
    apiKey: process.env.SAPIOM_API_KEY,
    traceId: 'my-agent-session',
    agentName: 'customer-support-bot',
    failureMode: 'open'  // 'open' | 'closed'
  }
);

// All operations (model + tools) grouped under one trace
await agent.invoke({
  messages: [{ role: "user", content: "Hello" }]
});
```

### Advanced Usage

For more control, you can manually wrap individual components:

#### Models

Drop-in replacements for LangChain chat models:

```typescript
import { SapiomChatOpenAI, SapiomChatAnthropic } from '@sapiom/langchain-classic';

// OpenAI
const openai = new SapiomChatOpenAI(
  { model: 'gpt-4', openAIApiKey: process.env.OPENAI_API_KEY },
  { apiKey: process.env.SAPIOM_API_KEY }
);

// Anthropic
const anthropic = new SapiomChatAnthropic(
  { model: 'claude-3-5-sonnet-20241022', anthropicApiKey: process.env.ANTHROPIC_API_KEY },
  { apiKey: process.env.SAPIOM_API_KEY }
);
```

#### Tools

Wrap existing tools or create new ones with Sapiom tracking:

```typescript
import { wrapSapiomTool, sapiomTool } from '@sapiom/langchain-classic';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

// Wrap existing tool
const existingTool = new DynamicStructuredTool({
  name: "weather",
  description: "Get weather for a city",
  schema: z.object({ city: z.string() }),
  func: async ({ city }) => `Weather in ${city}: Sunny`
});

const wrappedTool = wrapSapiomTool(existingTool, {
  apiKey: process.env.SAPIOM_API_KEY,
  serviceName: 'weather-api'
});

// Or create new tool with built-in tracking
const newTool = sapiomTool(
  async ({ city }) => `Weather in ${city}: Sunny`,
  {
    name: "weather",
    description: "Get weather for a city",
    schema: z.object({ city: z.string() })
  },
  {
    apiKey: process.env.SAPIOM_API_KEY,
    serviceName: 'weather-api'
  }
);
```

#### Manual Agent Wrapping

If you need to wrap an existing agent graph:

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { wrapSapiomAgent, SapiomChatOpenAI } from '@sapiom/langchain-classic';

// Create model and tools with Sapiom tracking
const model = new SapiomChatOpenAI(
  { model: 'gpt-4' },
  { apiKey: process.env.SAPIOM_API_KEY }
);

const tools = [
  // ... your wrapped tools
];

// Create LangChain agent
const graph = await createReactAgent({ llm: model, tools });

// Wrap with Sapiom for unified trace tracking
const agent = wrapSapiomAgent(graph, {
  apiKey: process.env.SAPIOM_API_KEY,
  traceId: 'agent-workflow',
  agentName: 'customer-support-bot',
  failureMode: 'open'
});

// All operations (model + tools) grouped under one trace
await agent.invoke({ messages: [{ role: "user", content: "Hello" }] });
```

## Environment Variables

Automatically reads from environment:
- `SAPIOM_API_KEY` (required)
- `SAPIOM_BASE_URL` or `SAPIOM_API_URL` (optional)
- `SAPIOM_TIMEOUT` (optional, in milliseconds)

## License

MIT © [Sapiom](../../LICENSE)

## Links

- [Documentation](https://docs.sapiom.ai)
- [GitHub](https://github.com/sapiom/sapiom-js)
- [NPM](https://www.npmjs.com/package/@sapiom/langchain-classic)
