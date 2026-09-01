---
"@sapiom/harness": minor
---

Agent Studio now fetches its coding-agent system prompt from the Sapiom backend on session start (`GET /v1/harness/system-prompt`), instead of using only the copy baked into this package. Prompt improvements now reach a session after a backend deploy rather than after an npm upgrade. The bundled prompt remains the offline fallback — a non-200, empty body, network error or 5s timeout starts the session on it, exactly as before.

The request is unconditional: it fetches configuration rather than reporting usage, so it is not gated on the telemetry opt-in, and it carries no session content, identifiers or API key. Set `SAPIOM_HARNESS_PROMPT_FETCH_DISABLED=1` (or `true`) to skip it and always use the bundled prompt — see the README's "Outbound requests" section.
