---
"@sapiom/agent-core": patch
---

Harden deploy and local-run input handling:

- Redact credentials from git error output, so a push URL's embedded token can never leak into an error hint or the deploy stream.
- On an auth-class deploy-push failure, mint a fresh push credential and retry the push once.
- Report a superseded build as a distinct, non-alarming outcome (a newer deploy replaced this build) instead of a generic build failure.
- Default an absent local-run input to `{}`, so a step that reads its input behaves the same locally as it does in a production run.
