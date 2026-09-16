---
"@sapiom/tools": minor
---

Group connected-provider capabilities under a `connectors` namespace, and back Google's `authClient()` with the server-side proxy so the OAuth token never enters your run.

**Breaking**

- `sapiom.google.*` / `sapiom.github.*` are now `sapiom.connectors.google.*` / `sapiom.connectors.github.*` (same on `ctx.sapiom.*`). The ambient import is `import { connectors } from "@sapiom/tools"` (was `google` / `github`), and the subpath export is `@sapiom/tools/connectors`.
- `connectors.google.token()` is removed. The OAuth token is resolved and injected server-side and is never returned to your run — use `connectors.google.authClient()` for the vendor SDKs, or `connectors.google.fetch()` for ad-hoc endpoints.

**Changed**

- `connectors.google.authClient()` still returns a real `google-auth-library` `OAuth2Client` for `googleapis` / `@googleapis/*`, but every request it makes is now redirected through the connectors proxy, so the Google token stays out of your run. `google-auth-library` remains an optional peer, loaded only when `authClient()` is called.

**Added**

- `connectors.google.fetch(pathOrUrl, init?)` — a generic proxied fetch for an endpoint not covered by a method or the vendor SDK.

`connectors.google.drive.*` / `connectors.google.gmail.*` and `connectors.github.listRepos()` are unchanged apart from the namespace move.
