---
"@sapiom/tools": minor
---

Add Google and GitHub capabilities to `ctx.sapiom`, with credentials injected by the gateway:

- `google.token()` — a short-lived Google bearer for the tenant's connected account.
- `google.authClient()` — a `google-auth-library` `OAuth2Client` that mints and refreshes its token through the gateway, so it drops straight into `googleapis` and the `@googleapis/*` clients. `google-auth-library` is an optional peer dependency, loaded only when `authClient()` is called; a token-only integration needs no extra dependency.
- `google.drive.shareFile()` / `google.drive.uploadFile()` and `google.gmail.sendEmail()` — Drive and Gmail actions execute server-side in the gateway, so the Google token never reaches agent code.
- `github.listRepos()` — list repositories for a connected GitHub account.
