---
"@sapiom/harness": minor
---

`HarnessSettings.helpSeen` records that the first-run Studio explainer has been dismissed. The flag previously lived in browser `localStorage`, which is keyed by origin; hosts that bind an ephemeral port — the desktop app does, on every boot — presented a new origin with empty storage each launch and re-showed the card every time. It is now per-install and origin-independent, and it survives a reset of the client-side `ui-prefs` blob.

Also fixes `PATCH /api/settings` silently dropping `telemetryNoticeDismissed`: the field was absent from the request schema, which strips unknown keys, so the request succeeded and nothing was written. Because nothing was ever stored, there is no earlier dismissal to honour — installs will see the telemetry notice one final time after upgrading, and the next dismissal is the first one that persists. `settings.json` gains the key at that point.
