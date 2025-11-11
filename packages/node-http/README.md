# @sapiom/node-http

[![npm version](https://badge.fury.io/js/%40sapiom%2Fnode-http.svg)](https://www.npmjs.com/package/@sapiom/node-http)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Beta Status:** Currently in v0.x. API may change before v1.0.0. Production-ready and actively maintained.

Node.js HTTP/HTTPS integration for Sapiom SDK providing automatic payment handling (402 errors) and pre-emptive authorization.

## Installation

```bash
npm install @sapiom/core @sapiom/node-http
```

**Note:** `@sapiom/core` is a required peer dependency.

## Quick Start

```typescript
import { createSapiomClient } from '@sapiom/node-http';

const client = createSapiomClient({
  sapiom: {
    apiKey: process.env.SAPIOM_API_KEY
  }
});

const response = await client.request({
  method: 'GET',
  url: 'https://api.example.com/data'
});
```

## Features

- ✅ Native Node.js http/https support
- ✅ Automatic 402 payment handling
- ✅ Pre-emptive authorization
- ✅ Full TypeScript support
- ✅ Zero dependencies (uses Node.js stdlib)
- ✅ Environment variable configuration

## Configuration

```typescript
import { createSapiomClient } from '@sapiom/node-http';

const client = createSapiomClient({
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
- [NPM](https://www.npmjs.com/package/@sapiom/node-http)
