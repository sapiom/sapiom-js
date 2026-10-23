---
"@sapiom/fetch": patch
"@sapiom/axios": patch
"@sapiom/node-http": patch
---

Harden 402 payment handling, preserve request metadata across clones, and redact sensitive headers (including `Sapiom-Identity`) from telemetry.
