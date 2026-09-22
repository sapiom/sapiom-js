# google

Act as a tenant inside Google — Drive, Gmail, and the raw Google API surface — over
the tenant's connected Google connector. The same Google capability your agents
call over MCP, callable directly from your code or from within a Sapiom agent
step. The tenant must have connected Google first — an unconnected tenant gets a
`404 connector_not_found` (connect Google, then call).

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Drive/Gmail run server-side in the gateway — the Google token never reaches
// your code; only the result comes back.
await sapiom.connectors.google.drive.shareFile({
  fileId: "1AbC…",
  role: "reader",
  type: "anyone",
});

await sapiom.connectors.google.gmail.sendEmail({
  to: "person@example.com",
  subject: "Hello",
  text: "Sent by my agent, as the tenant.",
});
```

Ambient import works too: `import { connectors } from "@sapiom/tools"` (then `connectors.google`).

Drive a Google vendor SDK directly with a proxy-backed client — every request it
makes is redirected through the connectors proxy, so the OAuth token never
enters your run:

```typescript
import { drive } from "@googleapis/drive";

const files = await drive({
  version: "v3",
  auth: await sapiom.connectors.google.authClient(),
}).files.list({ pageSize: 10 });
```

Or hit an ad-hoc endpoint with the generic proxied tail, with no extra
dependency:

```typescript
const res = await sapiom.connectors.google.fetch(
  "https://sheets.googleapis.com/v4/spreadsheets/ID",
);
```

## Operations

- `authClient()` — a real `google-auth-library` `OAuth2Client`, PROXY-backed:
  every request it makes is redirected through the connectors proxy, which
  resolves the tenant's Google credential and injects it server-side; pass it
  straight to `googleapis` / `@googleapis/*`. `google-auth-library` is an
  **optional peer** (imported only when `authClient()` is called; it ships
  transitively with `googleapis`), so `fetch()`-only callers never pull it in.
- `fetch(pathOrUrl, init?)` — the generic proxied tail, for an endpoint not
  covered by a method or the vendor SDK. Pass an absolute Google URL or a bare
  path; the tenant credential is added automatically and the OAuth token is
  injected server-side, never in your run.
- `drive.shareFile(args)` — share a Drive file (Permissions: create), server-side.
- `drive.uploadFile(args)` — upload a new Drive file (Files: create), server-side.
- `gmail.sendEmail(args)` — send an email via Gmail, server-side. `to` / `cc` /
  `bcc` accept a single address or an array.

`drive`/`gmail` execute inside the gateway on the tenant's credential — the
Google token never crosses into your run, only the result does. `authClient()`
and `fetch()` also keep the token out of your run, but let you drive the vendor
SDKs / hit ad-hoc endpoints yourself, through the proxy.
