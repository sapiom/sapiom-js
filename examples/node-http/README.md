# Node HTTP Example

Demonstrates `@sapiom/node-http` - a native Node.js HTTP client that automatically handles authorization and payment.

## Setup

```bash
# Install dependencies
npm install

# Copy environment config from examples root
cp ../.env.example .env

# Edit .env with your API keys
```

## Run

```bash
npm start
```

## What This Shows

- Create a Sapiom HTTP client with `createClient()`
- Use `client.request()` for HTTP requests
- Authorization and 402 payment handling happen automatically

## Key Code

```typescript
import { createClient } from "@sapiom/node-http";

// One-time setup
const client = createClient({
  apiKey: process.env.SAPIOM_API_KEY,
});

// Make requests - Sapiom handles auth/payment transparently
const response = await client.request({
  method: "GET",
  url: "https://api.example.com/data",
});
```
