---
"@sapiom/tools": minor
---

Add `browserAutomation.withManagedSession`, which creates a managed browser session, runs your callback, and always closes the session afterwards. When a creation outcome is uncertain, it retries with the same idempotency key and input, and it retries the close until settlement completes. It closes any session left behind by a creation that never confirmed, and it calls `onPendingClose` when a close still has not completed. The browser billing docs also now say that settlement captures reported usage up to the authorized amount, instead of saying settlement can fail when usage exceeds it.
