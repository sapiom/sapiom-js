# @sapiom/langchain

[![npm version](https://badge.fury.io/js/%40sapiom%2Flangchain.svg)](https://www.npmjs.com/package/@sapiom/langchain)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Beta Status:** Currently in v0.x. API may change before v1.0.0. Production-ready and actively maintained.

LangChain integration for Sapiom SDK providing automatic cost tracking and session management for LangChain agents, tools, and models.

## Version Compatibility

| Package Version | LangChain Version | Status |
|----------------|-------------------|---------|
| v0.x           | v0.3+            | ✅ Active |
| v1.0           | v1.0+            | 🚧 Planned |

This package currently supports LangChain v0.x. LangChain v1.x support coming in SDK v1.0.

## Installation

```bash
npm install @sapiom/langchain
```

## Quick Start

```typescript
import { SapiomChatOpenAI } from '@sapiom/langchain';

const model = new SapiomChatOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  sapiomApiKey: process.env.SAPIOM_API_KEY,
  model: 'gpt-4'
});

const response = await model.invoke('Hello!');
```

See [full README](https://github.com/sapiom/sapiom-javascript/tree/main/packages/langchain) for complete documentation.

## License

MIT © [Sapiom](../../LICENSE)
