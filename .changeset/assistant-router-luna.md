---
"@sapiom/harness": patch
"@sapiom/opencode": patch
---

Route the Assistant through router.sapiom.ai using Luna and the Responses API.
Preserve streaming tool use, account-scoped credentials, and bounded retries for
empty answers. Custom Assistant gateways must support /v1/responses.
