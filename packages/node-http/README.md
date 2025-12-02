# @sapiom/node-http

[![npm version](https://badge.fury.io/js/%40sapiom%2Fnode-http.svg)](https://www.npmjs.com/package/@sapiom/node-http)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Beta Status:** Currently in v0.x. API may change before v1.0.0. Production-ready and actively maintained.

Node.js HTTP/HTTPS integration for Sapiom SDK providing automatic payment handling (402 errors) and pre-emptive authorization.

## Installation

```bash
npm install @sapiom/node-http
```

## Quick Start

```typescript
import { createClient } from '@sapiom/node-http';

const client = createClient({
  apiKey: process.env.SAPIOM_API_KEY
});

const response = await client.request({
  method: 'GET',
  url: 'https://api.example.com/data',
  headers: {}
});
```

## Features

- ✅ Native Node.js http/https support
- ✅ Automatic 402 payment handling
- ✅ Pre-emptive authorization
- ✅ Full TypeScript support
- ✅ Uses Node.js standard library (no additional HTTP client needed)
- ✅ Environment variable configuration

## Configuration

```typescript
import { createClient } from '@sapiom/node-http';

const client = createClient({
  // Required (or use SAPIOM_API_KEY environment variable)
  apiKey: 'sk_...',

  // Optional - Control
  enabled: true,              // Enable Sapiom handling (default: true)
  failureMode: 'open',        // 'open' | 'closed' (default: 'open')
                              // 'open': Allow requests if Sapiom fails (prioritizes availability)
                              // 'closed': Block requests if Sapiom fails (prioritizes security)

  // Optional - Default metadata (applied to all requests)
  agentName: 'my-agent',      // Agent identifier
  agentId: 'agent-123',       // Agent UUID or numeric ID
  serviceName: 'my-service',  // Service name for transactions
  traceId: 'trace-xyz',       // Internal trace UUID
  traceExternalId: 'ext-456', // External trace identifier
});
```

### Per-Request Overrides

Override configuration for individual requests using the `__sapiom` property:

```typescript
// Disable Sapiom for a specific request
await client.request({
  method: 'GET',
  url: 'https://api.example.com/public',
  headers: {},
  __sapiom: { enabled: false }
});

// Override metadata for a specific request
await client.request({
  method: 'POST',
  url: 'https://api.example.com/resource',
  headers: { 'Content-Type': 'application/json' },
  body: { data: 'test' },
  __sapiom: {
    serviceName: 'different-service',
    actionName: 'custom-action',
    traceExternalId: 'ext-789'
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
- [GitHub](https://github.com/sapiom/sapiom-js)
- [NPM](https://www.npmjs.com/package/@sapiom/node-http)
