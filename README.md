# Sapiom SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)

> ⚠️ **Beta Status:** Currently in v0.x (beta). API may change before v1.0.0.
> Production-ready and actively maintained.

TypeScript SDK for building AI agents and applications with the Sapiom API. Provides seamless payment handling, authorization flows, and framework integrations.

## 📦 Packages

This is a monorepo containing multiple focused packages. Install only what you need:

### Core Package

| Package | Version | Description |
|---------|---------|-------------|
| [@sapiom/core](./packages/core) | v0.1.0 | Core transaction client, handlers, and utilities |

### HTTP Client Integrations

| Package | Version | Description |
|---------|---------|-------------|
| [@sapiom/axios](./packages/axios) | v0.1.0 | Axios HTTP client integration |
| [@sapiom/fetch](./packages/fetch) | v0.1.0 | Native Fetch API integration |
| [@sapiom/node-http](./packages/node-http) | v0.1.0 | Node.js HTTP/HTTPS integration |

### Framework Integrations

| Package | Version | LangChain | Description |
|---------|---------|-----------|-------------|
| [@sapiom/langchain](./packages/langchain) | v0.1.0 | v1.x | LangChain v1.x integration (recommended) |
| [@sapiom/langchain-classic](./packages/langchain-classic) | v0.1.0 | v0.3+ | LangChain v0.x integration (legacy) |

### Coming Soon

- `@sapiom/mastra` - Mastra framework integration
- `@sapiom/langgraph` - LangGraph integration  
- `@sapiom/openai` - OpenAI SDK integration

## 🚀 Quick Start

### For Axios Users

```bash
npm install @sapiom/axios axios
```

```typescript
import axios from 'axios';
import { createSapiomClient } from '@sapiom/axios';

const client = createSapiomClient(axios.create({
  baseURL: 'https://api.example.com'
}));

const response = await client.get('/premium-endpoint');
```

### For Fetch Users

```bash
npm install @sapiom/fetch
```

```typescript
import { createSapiomFetch } from '@sapiom/fetch';

const fetch = createSapiomFetch();
const response = await fetch('https://api.example.com/data');
```

### For LangChain v1.x Users

```bash
npm install @sapiom/langchain langchain
```

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

const result = await agent.invoke({
  messages: [{ role: "user", content: "What's the weather?" }],
});
```

### For LangChain v0.x Users (Legacy)

```bash
npm install @sapiom/langchain-classic
```

```typescript
import { createSapiomReactAgent } from '@sapiom/langchain-classic';

const agent = await createSapiomReactAgent(
  { llm: new ChatOpenAI({ model: "gpt-4" }), tools: [...] },
  { apiKey: process.env.SAPIOM_API_KEY }
);

const response = await agent.invoke({ messages: [...] });
```

### For Direct API Access

If you only need the transaction client without HTTP integrations:

```bash
npm install @sapiom/core
```

```typescript
import { SapiomClient } from '@sapiom/core';

const client = new SapiomClient({
  apiKey: process.env.SAPIOM_API_KEY
});

const transaction = await client.transactions.create({
  service: 'api',
  action: 'call',
  resource: 'completion'
});
```

## 📚 Documentation

- **[@sapiom/core](./packages/core/README.md)** - Core SDK documentation
- **[@sapiom/axios](./packages/axios/README.md)** - Axios integration guide
- **[@sapiom/fetch](./packages/fetch/README.md)** - Fetch integration guide
- **[@sapiom/node-http](./packages/node-http/README.md)** - Node.js HTTP integration guide
- **[@sapiom/langchain](./packages/langchain/README.md)** - LangChain integration guide

## 🏗️ Package Architecture

```
@sapiom/core              Core transaction API & utilities
    ↑
    ├── @sapiom/axios     Axios integration
    ├── @sapiom/fetch     Fetch integration
    ├── @sapiom/node-http Node HTTP integration
    └── @sapiom/langchain LangChain integration
```

All integration packages depend on `@sapiom/core` but are independent of each other.

## 🔧 Version Compatibility

### LangChain Support

| Package | LangChain Version | Status |
|---------|-------------------|---------|
| `@sapiom/langchain` | v1.x | ✅ Recommended |
| `@sapiom/langchain-classic` | v0.3+ | ✅ Legacy Support |

- **New projects**: Use `@sapiom/langchain` with LangChain v1.x
- **Existing v0.x projects**: Use `@sapiom/langchain-classic` (no changes needed)

## 🛠️ Development

This is a pnpm workspace monorepo.

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint and format
pnpm lint
pnpm format
```

### Package Scripts

```bash
# Build specific package
pnpm --filter @sapiom/core build
pnpm --filter @sapiom/axios build

# Test specific package
pnpm --filter @sapiom/langchain test

# Run in watch mode
pnpm --filter @sapiom/core dev
```

### Publishing

We use [Changesets](https://github.com/changesets/changesets) for version management:

```bash
# Create a changeset
pnpm changeset

# Version packages
pnpm version-packages

# Publish to npm
pnpm release
```

## 🤝 Contributing

Contributions welcome! Please read our [Contributing Guide](./CONTRIBUTING.md) first.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT © [Sapiom](LICENSE)

## 🔗 Links

- [Website](https://sapiom.com)
- [Documentation](https://docs.sapiom.com)
- [NPM Organization](https://www.npmjs.com/org/sapiom)
- [GitHub Issues](https://github.com/sapiom/sapiom-javascript/issues)

## 🌟 Features

- ✅ **Modular architecture** - Install only what you need
- ✅ **Lightweight core** - Minimal dependencies and small footprint
- ✅ **HTTP client agnostic** - Works with Axios, Fetch, Node HTTP
- ✅ **Framework integrations** - LangChain, Mastra (coming soon)
- ✅ **Automatic payment handling** - 402 Payment Required flows
- ✅ **Pre-emptive authorization** - Protect endpoints before access
- ✅ **TypeScript native** - Full type safety
- ✅ **Tree-shakeable** - Optimal bundle sizes
- ✅ **Node.js 18+** - Native fetch support

## 🗺️ Roadmap

- [x] Core transaction API
- [x] Axios integration
- [x] Fetch integration  
- [x] Node.js HTTP integration
- [x] LangChain v0.x integration
- [x] LangChain v1.x integration (middleware-based)
- [ ] GitHub Actions CI/CD
- [ ] Mastra integration
- [ ] LangGraph integration
- [ ] OpenAI SDK integration
- [ ] Browser support (via bundlers)
- [ ] WebSocket support for streaming
