---
"@sapiom/harness": minor
---

Track ordinary session input delivery and runtime ownership so partial input, preemption, stale ingest events, and shutdown are handled consistently.

Background input now yields to terminal keystrokes received while its durable pre-write hook is pending. A submission displaced before writing compensates its durable claim so it can be recovered safely.

**Breaking for embedders** (minor while the package is pre-1.0): `SessionManager.write()` can throw an isolation error with code `SESSION_INPUT_ISOLATION_REQUIRED` when prior partial input cannot be cleared. Callers forwarding terminal bytes should handle this failure and keep the terminal available for a later retry instead of assuming every call returns a boolean.
