---
"@sapiom/harness": minor
"@sapiom/mcp": minor
---

Let Studio request and privately retain a delegated signed-in user credential alongside its existing organization connection. Serialize user-token refresh with Studio login/sign-out, persist rotations atomically, and revoke the user-token family on sign-out when the backend is reachable. Existing CLI callers and legacy project ownership remain unchanged.
