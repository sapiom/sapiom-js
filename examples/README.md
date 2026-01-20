# Sapiom SDK Examples

Quick start guide for integrating Sapiom into your AI agents.

## Prerequisites

- Node.js 18+
- An invite to Sapiom (check your email for signup link to https://app.sapiom.ai/)

## Setup

### 1. Get your Sapiom API Key

1. Sign up / log in at https://app.sapiom.ai/
2. Go to **Settings** (gear icon)
3. Create a new API key
4. Copy the key - this is your `SAPIOM_API_KEY`

### 2. Configure your environment

```bash
# Pick an example to try (axios is simplest)
cd axios

# Install dependencies
npm install

# Copy the environment template
cp ../.env.example .env
```

Edit `.env` and fill in your keys:

```bash
SAPIOM_API_KEY=your-key-from-step-1
SAPIOM_API_URL=https://api.sapiom.ai

# For axios/fetch/node-http examples:
DUMMY_SERVER_URL=https://x402-demo-server.onrender.com

# For langchain examples only:
ANTHROPIC_API_KEY=sk-ant-your-key
```

> **Note:** The `DUMMY_SERVER_URL` points to a public demo server that simulates paid API endpoints. The default URL in `.env.example` is ready to use.

### 3. Run an example

```bash
# Default: runs free endpoints only (no balance required)
npm start

# Or explicitly:
npm run free    # Free endpoints (authorization only)
npm run full    # All endpoints (requires Sapiom balance for payments)
```

**Start with `npm start`** - this uses free endpoints and doesn't require a balance. You can test:
- Basic SDK integration
- Authorization tracking
- Usage rules

If you have a balance in your account (check https://app.sapiom.ai/), you can run `npm run full` to test paid endpoints and spending rules.

## Verify it's working

After running an example, check the Sapiom dashboard:

1. **Activity** (https://app.sapiom.ai/activity) - See all transactions from your agent
2. **Agents** (https://app.sapiom.ai/agents) - Your agent should appear here
3. **Services** (https://app.sapiom.ai/services) - See the services your agent accessed

## Test authorization denial

To see how Sapiom handles policy violations:

1. Go to **Rules** (https://app.sapiom.ai/rules)
2. Click **Add New Rule**
3. Create a usage limit:
   - **Name:** "Test Usage Limit"
   - **Limit Type:** Usage
   - **Maximum:** 1 call
   - **Time Period:** Per Run
   - **Services:** All Services
   - **Agents:** All Agents
4. Click **Create Rule**
5. Run the example again

On the second request, you should see an `AuthorizationDeniedError` - this means Sapiom blocked the request based on your rule.

## Available Examples

| Example | Package | Best for |
|---------|---------|----------|
| `axios/` | `@sapiom/axios` | Existing Axios codebases |
| `fetch/` | `@sapiom/fetch` | Native fetch API users |
| `node-http/` | `@sapiom/node-http` | Raw Node.js HTTP |
| `langchain-classic/` | `@sapiom/langchain-classic` | LangChain v0.3.x with tool wrappers |

> **Note:** The `langchain/` example is for LangChain v1.x. Use `langchain-classic/` if you're on LangChain v0.3.x.

Start with `axios/` or `fetch/` - they're the simplest to understand.

## About the Demo Server

The examples connect to a demo server that simulates real-world APIs with payment requirements. This server implements the [x402 payment protocol](https://www.x402.org/) - an HTTP standard where APIs can require micropayments.

**How it works:**

1. Your code makes a normal HTTP request (e.g., `POST /api/sms`)
2. The server returns `402 Payment Required` with pricing info
3. The Sapiom SDK automatically handles the payment
4. The server validates payment and returns the response

You don't need to understand the x402 protocol - the Sapiom SDK handles it transparently. Your code just makes normal HTTP requests.

The demo server simulates a marketing platform with:
- **CRM endpoints** - Customer data (free, but requires authorization)
- **SMS endpoints** - Send messages (paid per message)
- **Analytics endpoints** - Campaign metrics (paid + authorization)

## Demo Server Endpoints

The demo server (`DUMMY_SERVER_URL`) provides these endpoints:

### Free endpoints (no balance required)

| Endpoint | Auth | Payment | Description |
|----------|------|---------|-------------|
| `GET /api/public/time` | No | No | Current server time |
| `GET /api/public/status` | No | No | Server health check |
| `GET /api/crm/customers` | Yes | No | Fetch customer list |

### Paid endpoints (require balance)

| Endpoint | Auth | Payment | Description |
|----------|------|---------|-------------|
| `POST /api/sms` | No | $0.0075 | Send SMS message |
| `POST /api/campaigns/analytics` | Yes | $0.05 | Get campaign analytics |

The Sapiom SDK handles all authorization and payment automatically - your code just makes normal HTTP requests.

**Note:** If you run `npm run full` without a balance, the paid requests will fail and show as "Denied" in the Activity dashboard (https://app.sapiom.ai/activity).

## Troubleshooting

**"SAPIOM_API_KEY environment variable is required"**
- Make sure you copied `.env.example` to `.env` and filled in your API key

**Connection refused / timeout**
- Check that `DUMMY_SERVER_URL` is correct and the test server is running

**AuthorizationDeniedError on first request**
- Check your Rules in the dashboard - you may have a restrictive policy

**Nothing showing in dashboard**
- Verify your `SAPIOM_API_KEY` is correct
- Check the console output for errors

## Questions?

Reach out to your Sapiom contact or email support@sapiom.ai
