---
"@sapiom/harness": patch
---

Typed error codes on session and spawn failures; HTTP status mappings unchanged.

Adds a `HarnessError` base class and five typed subclasses — `UnknownSessionError`, `SessionNotReadyError`, `SessionNotResumeableError`, `SessionAlreadyLiveError`, `AdapterNotFoundError` — each carrying a stable machine-readable `code` property. Server routes now dispatch on `instanceof` rather than parsing `error.message` text, so future message rewordings cannot silently alter the HTTP status they produce. Wire responses and response body shapes are unchanged.
