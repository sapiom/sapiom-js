---
"@sapiom/harness": patch
---

Retry fully received incomplete Assistant model responses up to twice before exposing output or tool calls. Pass through tool fragments, refusals, errors, uncertain endings, and oversized prefixes without retrying. A completion declaration is the model's report and does not independently verify task success.
