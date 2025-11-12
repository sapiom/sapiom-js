# @sapiom/fetch

[![npm version](https://badge.fury.io/js/%40sapiom%2Ffetch.svg)](https://www.npmjs.com/package/@sapiom/fetch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Beta Status:** Currently in v0.x. API may change before v1.0.0. Production-ready and actively maintained.

Fetch API integration for Sapiom SDK providing automatic payment handling (402 errors) and pre-emptive authorization.

## Installation

```bash
npm install @sapiom/fetch
```

**Note:** Requires Node.js 18+ (native fetch).

## Quick Start

```typescript
import { createSapiomFetch } from '@sapiom/fetch';

const fetch = createSapiomFetch({
  sapiom: {
    apiKey: process.env.SAPIOM_API_KEY
  }
});

// Drop-in replacement for native fetch
const response = await fetch('https://api.example.com/data');
const data = await response.json();
```

## Features

- ✅ Drop-in replacement for native fetch
- ✅ Automatic 402 payment handling
- ✅ Pre-emptive authorization
- ✅ Full TypeScript support
- ✅ Zero dependencies (uses native fetch)
- ✅ Environment variable configuration

## Configuration

```typescript
import { createSapiomFetch } from '@sapiom/fetch';

const fetch = createSapiomFetch({
  sapiom: {
    apiKey: string;
    baseURL?: string;
    timeout?: number;
  },
  authorization?: {
    enabled?: boolean;
    authorizedEndpoints?: Array<{
      pathPattern: RegExp;
      service: string;
    }>;
  },
  payment?: {
    enabled?: boolean;
    onPaymentRequired?: (txId: string, payment: PaymentDetails) => void;
  }
});
```

## Environment Variables

Automatically reads from environment:
- `SAPIOM_API_KEY` (required)
- `SAPIOM_BASE_URL` or `SAPIOM_API_URL` (optional)
- `SAPIOM_TIMEOUT` (optional, in milliseconds)

## License

MIT © [Sapiom](../../LICENSE)

## Links

- [Documentation](https://docs.sapiom.com)
- [GitHub](https://github.com/sapiom/sdk)
- [NPM](https://www.npmjs.com/package/@sapiom/fetch)
