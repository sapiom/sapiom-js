# Sapiom SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)

> ⚠️ **Beta Status:** Currently in v0.x (beta). API may change before v1.0.0.
> Production-ready and actively maintained.

TypeScript SDK for building AI agents and applications with the Sapiom API. Provides seamless payment handling, authorization flows, and framework integrations.

## 📦 Packages

This is a monorepo containing multiple packages:

| Package | Version | Description |
|---------|---------|-------------|
| [@sapiom/core](./packages/core) | v0.1.0 | Core SDK with HTTP adapters and transaction management |
| [@sapiom/langchain](./packages/langchain) | v0.1.0 | LangChain integration (v0.x compatible) |

### Coming Soon
- `@sapiom/mastra` - Mastra framework integration
- `@sapiom/langgraph` - LangGraph integration
- `@sapiom/openai` - OpenAI SDK integration

## 🚀 Quick Start

### For LangChain Users

```bash
npm install @sapiom/core @sapiom/langchain
```

```typescript
import { SapiomChatOpenAI } from '@sapiom/langchain';

const model = new SapiomChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  sapiomApiKey: process.env.SAPIOM_API_KEY,
  model: 'gpt-4'
});

const response = await model.invoke('Hello!');
```

### For HTTP Client Users

```bash
npm install @sapiom/core
```

```typescript
import axios from 'axios';
import { createSapiomClient } from '@sapiom/core/axios';

const client = createSapiomClient(axios.create({
  baseURL: 'https://api.example.com'
}));

// Automatically handles 402 payment flows
const response = await client.get('/premium-endpoint');
```

### For Direct API Access

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
- **[@sapiom/langchain](./packages/langchain/README.md)** - LangChain integration guide
- **[Examples](./examples)** - Code examples for all packages

## 🔧 Version Compatibility

### LangChain Support

| SDK Version | LangChain Version | Status |
|------------|-------------------|---------|
| v0.x       | v0.3+            | ✅ Active |
| v1.0       | v1.0+            | 🚧 Planned |

The `@sapiom/langchain` package currently supports LangChain v0.x. When LangChain v1.0 stabilizes, we'll release SDK v1.0 with updated support.

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
- [GitHub Issues](https://github.com/sapiom/sdk/issues)
- [Discord Community](https://discord.gg/sapiom)

## 🌟 Features

- ✅ **Zero dependencies** (core package)
- ✅ **HTTP client agnostic** (Axios, Fetch, Node HTTP)
- ✅ **Framework integrations** (LangChain, Mastra, more coming)
- ✅ **Automatic payment handling** (402 Payment Required flows)
- ✅ **Pre-emptive authorization** (protect endpoints before access)
- ✅ **TypeScript native** (full type safety)
- ✅ **Tree-shakeable** (only bundle what you use)
- ✅ **Node.js 18+** (native fetch support)

## 🗺️ Roadmap

- [x] Core transaction API
- [x] HTTP client adapters (Axios, Fetch, Node HTTP)
- [x] LangChain v0.x integration
- [ ] GitHub Actions CI/CD
- [ ] Mastra integration
- [ ] LangGraph integration
- [ ] OpenAI SDK integration
- [ ] LangChain v1.x support (SDK v1.0)
- [ ] Browser support (via bundlers)
- [ ] WebSocket support for streaming
