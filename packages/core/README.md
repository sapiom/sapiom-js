# @sapiom/core

[![npm version](https://badge.fury.io/js/%40sapiom%2Fcore.svg)](https://www.npmjs.com/package/@sapiom/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Beta Status:** Currently in v0.x. API may change before v1.0.0. Production-ready and actively maintained.

Core SDK for Sapiom API providing HTTP client adapters, transaction management, and automatic payment handling.

## Features

- ✅ **Lightweight core** - Minimal footprint with focused functionality
- ✅ **HTTP client agnostic** - Works with Axios, Fetch, Node HTTP
- ✅ **Automatic payment handling** - Handles 402 Payment Required flows
- ✅ **Pre-emptive authorization** - Protect endpoints before access
- ✅ **TypeScript native** - Full type safety
- ✅ **Tree-shakeable** - Only bundle what you use
- ✅ **Node.js 18+** - Uses native fetch

## Installation

```bash
npm install @sapiom/core
# or
pnpm add @sapiom/core
# or
yarn add @sapiom/core
```

## Quick Start

### Direct API Client

```typescript
import { SapiomClient } from '@sapiom/core';

const client = new SapiomClient({
  apiKey: process.env.SAPIOM_API_KEY,
  baseURL: 'https://api.sapiom.com' // optional
});

// Create a transaction
const transaction = await client.transactions.create({
  service: 'api',
  action: 'call',
  resource: 'completion',
  qualifiers: {
    model: 'gpt-4',
    tokens: 1000
  }
});

// Check transaction status
console.log(client.transactions.isAuthorized(transaction)); // boolean
```

### Axios Integration

For Axios integration, install the separate package:

```bash
npm install @sapiom/axios axios
```

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

See [@sapiom/axios](../axios/README.md) for complete documentation.

### Fetch Integration

For Fetch API integration, install the separate package:

```bash
npm install @sapiom/fetch
```

```typescript
import { createSapiomFetch } from '@sapiom/fetch';

const fetch = createSapiomFetch({
  sapiom: {
    apiKey: process.env.SAPIOM_API_KEY
  }
});

// Drop-in replacement for native fetch
const response = await fetch('https://api.example.com/data');
```

See [@sapiom/fetch](../fetch/README.md) for complete documentation.

### Node.js HTTP/HTTPS

For Node.js HTTP/HTTPS integration, install the separate package:

```bash
npm install @sapiom/node-http
```

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

See [@sapiom/node-http](../node-http/README.md) for complete documentation.

## API Reference

### SapiomClient

#### Constructor

```typescript
new SapiomClient(config: SapiomClientConfig)
```

**Config options:**
- `apiKey: string` - Required: Your Sapiom API key
- `baseURL?: string` - Optional: API base URL (default: https://api.sapiom.ai)
- `timeout?: number` - Optional: Request timeout in ms (default: 30000)
- `headers?: Record<string, string>` - Optional: Additional headers

#### Methods

##### transactions.create()

```typescript
await client.transactions.create({
  service: string;
  action: string;
  resource: string;
  qualifiers?: Record<string, any>;
  paymentData?: PaymentData;
  metadata?: Record<string, any>;
})
```

##### transactions.list()

```typescript
await client.transactions.list({
  status?: 'pending' | 'authorized' | 'declined' | 'failed' | 'completed' | 'cancelled';
  service?: string;
  limit?: number;
  offset?: number;
})
```

##### transactions.get()

```typescript
await client.transactions.get(transactionId: string)
```

##### Helper Methods

```typescript
client.transactions.isAuthorized(transaction): boolean
client.transactions.isCompleted(transaction): boolean
client.transactions.requiresPayment(transaction): boolean
client.transactions.getPaymentDetails(transaction): PaymentDetails | null
```

## HTTP Integrations

### Configuration Options

All HTTP integrations accept a config object:

```typescript
{
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
    onAuthorizationPending?: (txId: string, endpoint: string) => void;
  },
  payment?: {
    enabled?: boolean;
    onPaymentRequired?: (txId: string, payment: PaymentDetails) => void;
  }
}
```

### Environment Variables

All integrations automatically read from environment:

- `SAPIOM_API_KEY` (required)
- `SAPIOM_BASE_URL` or `SAPIOM_API_URL` (optional)
- `SAPIOM_TIMEOUT` (optional, in milliseconds)

## Error Handling

```typescript
try {
  const transaction = await client.transactions.create({...});
} catch (error) {
  if (error.response?.status === 401) {
    console.error('Authentication failed');
  } else if (error.response?.status === 402) {
    console.error('Payment required');
  } else if (error.response?.status === 403) {
    console.error('Access denied');
  }
}
```

## Advanced Usage

### Custom HTTP Adapter

```typescript
import { HttpClientAdapter } from '@sapiom/core/core';

class MyCustomAdapter implements HttpClientAdapter {
  async request(config: RequestConfig): Promise<Response> {
    // Your custom HTTP logic
  }
}
```

### Payment Error Detection

```typescript
import { PaymentErrorDetection } from '@sapiom/core';

const detector = new PaymentErrorDetection();

if (detector.is402Error(error)) {
  const info = detector.extractPaymentInfo(error);
  console.log('Payment required:', info.paymentData);
}
```

## TypeScript Types

```typescript
import type {
  SapiomClientConfig,
  Transaction,
  PaymentData,
  PaymentDetails,
  HttpClientAdapter,
  RequestConfig,
  Response
} from '@sapiom/core';
```

## License

MIT © [Sapiom](../../LICENSE)

## Links

- [Documentation](https://docs.sapiom.com)
- [GitHub](https://github.com/sapiom/sapiom-js)
- [NPM](https://www.npmjs.com/package/@sapiom/core)
- [Issues](https://github.com/sapiom/sapiom-js/issues)
