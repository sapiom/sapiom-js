---
"@sapiom/harness": minor
---

Remote telemetry now reaches the hosted collector.

The bespoke `CollectorBatcher` (which posted to a non-existent `/v1/harness/events` endpoint) has been replaced by `@sapiom/analytics-core`. Events are now delivered to `POST /v1/analytics/collector` — the same endpoint used by all other Sapiom SDK packages.

**What changes for users:**
- Remote telemetry (consent-gated, as before) now actually works. Previously all remote traffic was silently dropped because the target endpoint did not exist.
- The local `~/.sapiom/harness/events.ndjson` sink continues to be written on every event regardless of consent, unchanged.
- Consent behavior (stored settings toggle, `--no-telemetry` flag, `SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`) is unchanged.
- Anonymous identity migrates: on first boot after upgrade, the install's existing `~/.sapiom/harness/machine-id` value is seeded into `~/.sapiom/analytics.json` so the longitudinal join key survives across versions.
