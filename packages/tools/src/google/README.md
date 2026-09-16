# google

Act as a tenant inside Google — Drive, Gmail, and the raw OAuth credential — over
the tenant's connected Google connector. The same Google capability your agents
call over MCP, callable directly from your code or from within a Sapiom agent
step. The tenant must have connected Google first — an unconnected tenant gets a
`404 connector_not_found` (connect Google, then call).

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// Drive/Gmail run server-side in the gateway — the Google token never reaches
// your code; only the result comes back.
await sapiom.google.drive.shareFile({
  fileId: "1AbC…",
  role: "reader",
  type: "anyone",
});

await sapiom.google.gmail.sendEmail({
  to: "person@example.com",
  subject: "Hello",
  text: "Sent by my agent, as the tenant.",
});
```

Ambient import works too: `import { google } from "@sapiom/tools"`.

Drive a Google vendor SDK directly with a self-refreshing client:

```typescript
import { drive } from "@googleapis/drive";

const files = await drive({
  version: "v3",
  auth: await sapiom.google.authClient(),
}).files.list({ pageSize: 10 });
```

## Operations

- `token()` — a short-lived raw bearer (`LiveCredential`), materialized
  server-side from the tenant's connector. Use it, never log or persist it.
- `authClient()` — a real `google-auth-library` `OAuth2Client` whose tokens are
  minted on demand from `token()` and refreshed transparently; pass it straight
  to `googleapis` / `@googleapis/*`. `google-auth-library` is an **optional peer**
  (imported only when `authClient()` is called; it ships transitively with
  `googleapis`), so `token()`-only callers never pull it in.
- `drive.shareFile(args)` — share a Drive file (Permissions: create), server-side.
- `drive.uploadFile(args)` — upload a new Drive file (Files: create), server-side.
- `gmail.sendEmail(args)` — send an email via Gmail, server-side. `to` / `cc` /
  `bcc` accept a single address or an array.

The Drive and Gmail methods execute inside the gateway on the tenant's
credential — the Google token never crosses into your run, only the result does.
