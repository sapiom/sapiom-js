---
"@sapiom/harness": minor
---

`HarnessSettings.helpSeen` records that the first-run Studio explainer has been dismissed. The flag previously lived in browser `localStorage`, which is keyed by origin; hosts that bind an ephemeral port — the desktop app does, on every boot — presented a new origin with empty storage each launch and re-showed the card every time. It is now per-install and origin-independent, and it survives a reset of the client-side `ui-prefs` blob.

Also fixes `PATCH /api/settings` silently dropping `telemetryNoticeDismissed`: the field was absent from the request schema, which strips unknown keys, so the request succeeded and nothing was written. Installs that have dismissed the telemetry notice will now keep it dismissed, and `settings.json` gains the key.
