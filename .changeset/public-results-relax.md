---
"@sapiom/axios": minor
"@sapiom/core": minor
"@sapiom/fetch": minor
"@sapiom/langchain": minor
"@sapiom/langchain-classic": minor
"@sapiom/mcp": minor
"@sapiom/node-http": minor
"@sapiom/sandbox": minor
---

New: SDK Identity Token Lifecycle. Adds automatic Sapiom-Identity JWT management across all SDK packages. The SDK lazily fetches identity tokens from POST /v1/auth/tokens, caches them in-memory, and attaches the Sapiom-Identity header to requests whose target hostname matches the token's aud claim (direct or subdomain match).
