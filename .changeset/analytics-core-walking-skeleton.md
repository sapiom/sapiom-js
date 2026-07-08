---
"@sapiom/analytics-core": minor
---

Introduce `@sapiom/analytics-core` — a zero-dependency usage analytics emitter shared by Sapiom SDK packages.

- `createAnalytics(config)` returns `{ track, flush, shutdown, enabled, anonymousId, sessionId }`; `track()` is a synchronous enqueue that never throws, and `flush()`/`shutdown()` never reject.
- Consent precedence: programmatic `disabled: true` → `SAPIOM_TELEMETRY_DISABLED=1` → `DO_NOT_TRACK=1` → injected consent provider → default on. When disabled, nothing is written or sent.
- Anonymous machine identity persisted at `~/.sapiom/analytics.json` (mode 0600, created lazily, corrupt files silently regenerated), plus a one-time first-run notice on stderr.
- Batched delivery: flush every 3s, at 20 events, or best-effort on process exit; at most one retry per batch (jittered), then silent drop; per-field ~16KB cap flagged via `data._truncated`.
