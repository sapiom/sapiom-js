# @sapiom/axios

[![npm version](https://badge.fury.io/js/%40sapiom%2Faxios.svg)](https://www.npmjs.com/package/@sapiom/axios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Beta Status:** Currently in v0.x. API may change before v1.0.0. Production-ready and actively maintained.

Axios integration for Sapiom SDK providing automatic payment handling (402 errors) and pre-emptive authorization.

## Installation

```bash
npm install @sapiom/axios axios
```

## Quick Start

```typescript
import axios from 'axios';
import { createSapiomClient } from '@sapiom/axios';

const client = createSapiomClient(axios.create({
  baseURL: 'https://api.example.com'
}), {
  sapiom: {
    apiKey: process.env.SAPIOM_API_KEY
  }
});

// Automatically handles 402 payment flows
const response = await client.get('/premium-endpoint');
```

## Features

- ✅ Drop-in wrapper for Axios instances
- ✅ Automatic 402 payment handling
- ✅ Pre-emptive authorization
- ✅ Full TypeScript support
- ✅ Access to underlying SapiomClient
- ✅ Environment variable configuration

## Configuration

```typescript
import { createSapiomClient } from '@sapiom/axios';

const client = createSapiomClient(axiosInstance, {
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
- [GitHub](https://github.com/sapiom/sapiom-javascript)
- [NPM](https://www.npmjs.com/package/@sapiom/axios)
