---
"@sapiom/harness": patch
---

Bind Assistant requests to the current Studio lifecycle and restore newly started runtimes paused. Reopening Studio does not automatically recover earlier work; an explicit message enables execution. Include lifecycle changes in ordered Studio state updates and fence both managed engines during shutdown.
