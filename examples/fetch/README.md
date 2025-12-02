# Fetch Example

Demonstrates `@sapiom/fetch` - a drop-in replacement for native `fetch()` that automatically handles authorization and payment.

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

- Create a Sapiom-wrapped fetch function with `createFetch()`
- Use it exactly like native `fetch()`
- Authorization and 402 payment handling happen automatically

## Key Code

```typescript
import { createFetch } from "@sapiom/fetch";

// One-time setup
const safeFetch = createFetch({
  apiKey: process.env.SAPIOM_API_KEY,
});

// Use normally - Sapiom handles auth/payment transparently
const response = await safeFetch("https://api.example.com/data");
const data = await response.json();
```
