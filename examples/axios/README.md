# Axios Example

Demonstrates `@sapiom/axios` - a drop-in wrapper for Axios that automatically handles authorization and payment.

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
npm start       # Free endpoints only (no balance required)
npm run free    # Same as above
npm run full    # All endpoints including paid (requires balance)
```

`npm start`, `npm run free`, and `npm run full` start the local demo server automatically and set `DUMMY_SERVER_URL=http://localhost:3101` for the run. Override `DUMMY_SERVER_URL` only when you want to test against another compatible server.

## What This Shows

- Wrap your existing Axios instance with `withSapiom()`
- Use `client.get()` and `client.post()` exactly as before
- Authorization and 402 payment handling happen automatically

## Key Code

```typescript
import { withSapiom } from "@sapiom/axios";
import axios from "axios";

// One-time setup
const client = withSapiom(axios.create({ baseURL }), {
  apiKey: process.env.SAPIOM_API_KEY,
});

// Use normally - Sapiom handles auth/payment transparently
const response = await client.get("/api/customers");
```
