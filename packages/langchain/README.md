# @sapiom/langchain

> **LangChain v1.x Integration:** For LangChain v0.3.x, use [`@sapiom/langchain-classic`](../langchain-classic/README.md) instead.

LangChain v1.x integration for Sapiom SDK.

## Installation

```bash
npm install @sapiom/langchain langchain
```

> **Note:** The `createAgent` API shown below is part of LangChain v1.x.

## Quick Start

```typescript
import { createAgent } from "langchain";
import { createSapiomMiddleware } from "@sapiom/langchain";

const agent = createAgent({
  model: "gpt-4",
  tools: [getWeather, sendEmail],
  middleware: [
    createSapiomMiddleware({
      apiKey: process.env.SAPIOM_API_KEY,
    }),
  ],
});

// All model and tool calls are automatically tracked!
const result = await agent.invoke({
  messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
});
```

## Configuration

```typescript
createSapiomMiddleware({
  // Required (or use SAPIOM_API_KEY env var)
  apiKey: "sk-...",

  // Control behavior
  enabled: true,           // Enable/disable tracking
  failureMode: "open",     // 'open' (graceful) | 'closed' (strict)

  // Default trace/agent info
  traceId: "my-workflow",  // Groups related transactions
  agentId: "AG-001",       // Tag with existing agent
  agentName: "my-agent",   // Find-or-create agent by name
});
```

## Per-Invocation Overrides

```typescript
await agent.invoke(
  { messages: [...] },
  {
    context: {
      sapiomTraceId: "conversation-456",
      sapiomAgentId: "AG-002",
    },
  }
);
```

## Failure Modes

| Mode | Behavior |
|------|----------|
| `open` (default) | Log errors, continue without tracking |
| `closed` | Throw errors, block operations |

Authorization denials always throw regardless of failure mode.

## What Gets Tracked

- **Agent lifecycle**: Start/end transactions
- **Model calls**: Token estimation, actual usage, tool calls
- **Tool calls**: Pre-authorization, payment retry (x402-mcp)

## LangChain v0.x

For LangChain v0.x (< 1.0.0), use `@sapiom/langchain-classic`:

```bash
npm install @sapiom/langchain-classic
```

See [@sapiom/langchain-classic](../langchain-classic) for documentation.

## License

MIT © [Sapiom](../../LICENSE)

## Links

- [Documentation](https://docs.sapiom.ai)
- [GitHub](https://github.com/sapiom/sapiom-js)
- [NPM](https://www.npmjs.com/package/@sapiom/langchain)
