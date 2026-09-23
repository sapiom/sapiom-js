---
"@sapiom/tools": patch
---

Report execution HTTP requests separately from observed capability outcomes in
SDK telemetry. Repeated reads of a terminal execution share a bounded deduplication
cache across a client and its attributed views. Interrupted waits emit a separate
event without reporting that the server execution failed. Existing telemetry
opt-out settings remain supported.
