---
"@sapiom/harness": minor
---

HarnessAdapter registry with embedded/external modes

- Introduces `HarnessAdapterInfo` union type (`EmbeddedHarnessAdapterInfo` | `ExternalHarnessAdapterInfo`) with a `mode` field distinguishing harnesses spawned by the harness server from companion-app harnesses that own their own sessions.
- Adds a data-driven registry (`createHarnessAdapterRegistry`, `listHarnessAdapters`, `getHarnessAdapter`) backed by five built-in adapters: claude-code, codex (both embedded), pi, opencode (embedded, experimental), and conductor (external).
- Each adapter entry carries an `installMcpPrompt()` method with per-harness MCP install guidance — the skills-panel UI (SAP-1424) reads these from the registry rather than embedding its own copy.
- Adds `GET /api/harnesses` endpoint returning all adapters with `id`, `label`, `mode`, `experimental`, and `installed` fields. Embedded entries are session-createable today; external entries expose `mode:"external"` for future UI rendering.
- Adds `ExternalHarnessError` (code `HARNESS_EXTERNAL`) thrown when spawn or send is attempted on an external-mode harness. Maps to HTTP 409 in `POST /sessions/:id/input` and `POST /sessions/:id/resume`.
- Routes the codex-tailer branching in server/index.ts through `adapter.eventSource` instead of a hardcoded `session.harness !== "codex"` check.
- `UnknownHarnessAdapterError` (code `UNKNOWN_HARNESS_ADAPTER`) is thrown by registry lookups for unknown ids, listing known ids in the message for self-correction.
- claude-code and codex behavior is byte-identical — no changes to their existing runtime adapter implementations (launch/resume/doctor/listPastSessions).
