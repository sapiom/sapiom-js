# Mock x402 demo server

A tiny local stand-in for the hosted demo at `https://x402-demo.sapiom.ai`, which
has been returning `403` (see [issue #88](https://github.com/sapiom/sapiom-js/issues/88)).
It serves the endpoints the `axios`, `fetch`, and `node-http` examples call, with
realistic stub JSON, using only Node's built-in `http` module (no dependencies).

## Run it

```bash
cd examples/mock-server
npm install
npm start          # listens on http://localhost:3101
```

Then, in another terminal, point an example at it (this is the default in
`examples/.env.example`):

```bash
DUMMY_SERVER_URL=http://localhost:3101
```

## Endpoints

| Endpoint | Auth | Payment | Description |
| --- | --- | --- | --- |
| `GET /api/public/time` | No | No | Current server time |
| `GET /api/public/status` | No | No | Server health check |
| `GET /api/crm/customers` | Yes | No | Customer list (`?limit`, `?segment`) |
| `POST /api/sms` | No | $0.0075 | Send an SMS message |
| `POST /api/campaigns/analytics` | Yes | $0.05 | Campaign analytics |

The two `/api/public/*` endpoints need no Sapiom account at all. The CRM and paid
endpoints are still gated by the Sapiom **authorization** layer in the SDK, which
talks to `SAPIOM_API_URL` — that's separate from this server and unchanged by it.

## x402 payment challenge mode

By default the paid endpoints return `200` directly, so the examples "just work"
offline. To exercise the real x402 flow, start the server with:

```bash
MOCK_X402=1 npm start
```

Paid endpoints then respond with an x402 `402` payment challenge (matching
`X402ResponseV2`) until the SDK retries with a payment header. Completing that
flow requires a funded Sapiom account.
