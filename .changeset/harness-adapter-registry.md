---
"@sapiom/harness": minor
---

HarnessAdapter registry with embedded/external modes

- Introduces `HarnessAdapterInfo` union type (`EmbeddedHarnessAdapterInfo` | `ExternalHarnessAdapterInfo`) with a `mode` field distinguishing harnesses spawned by the harness server from companion-app harnesses that own their own sessions.
- Adds a data-driven registry (`createHarnessAdapterRegistry`, `listHarnessAdapters`, `getHarnessAdapter`) backed by five built-in adapters: claude-code, codex (both embedded), pi, opencode (embedded, experimental), and conductor (external).
- Each adapter entry carries an `installMcpPrompt()` method with per-harness MCP install guidance — the skills-panel Install MCP modal reads these from the registry rather than embedding its own copy.
- Adds `GET /api/harnesses` endpoint returning all adapters with `id`, `label`, `mode`, `experimental`, and `installed` fields. Embedded entries are session-createable today; external entries expose `mode:"external"` for future UI rendering.
- Adds `ExternalHarnessError` (code `HARNESS_EXTERNAL`, HTTP 409) thrown from `SessionManager.getAdapter()` (resume path) and `SessionManager.submitInput()` (input path) when a session's harness id resolves to an external-mode adapter. A `sessions.json` entry written by an earlier build, hand-edited, or imported with `harness="conductor"` now surfaces a clear "managed by the Conductor app" 409 instead of a generic adapter-not-found error or a silent 404.
- Exports `SPAWNABLE_HARNESS_KINDS` as a const tuple from `shared/types.ts` — the single source of truth that both derives the `HarnessKind` type and supplies the values to `z.enum()` in the session-creation schema, preventing drift between the two.
- Routes the codex-tailer branching in server/index.ts through `adapter.eventSource` instead of a hardcoded `session.harness !== "codex"` check.
- `UnknownHarnessAdapterError` (code `UNKNOWN_HARNESS_ADAPTER`) is thrown by registry lookups for unknown ids, listing known ids in the message for self-correction.
- claude-code and codex behavior is byte-identical — no changes to their existing runtime adapter implementations (launch/resume/doctor/listPastSessions).
