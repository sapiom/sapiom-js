---
"@sapiom/agent-core": minor
"@sapiom/mcp": minor
---

Expose all four backend trigger kinds from the local authoring MCP (SAP-3174).
`sapiom_dev_agents_schedule` now accepts `kind: "event"` (+ `eventType`) and
`kind: "webhook"` alongside `schedule_cron` / `schedule_once`. A webhook create
returns the public hook URL, the shown-once signing secret, and the signing
scheme in the tool result (HMAC-SHA256 over `timestamp.eventId.rawBody`, sent as
`X-Sapiom-Timestamp` / `X-Sapiom-Event-Id` / `X-Sapiom-Signature`), and the
description says when a webhook trigger fits versus an App Link `/hook/*`
receiver (third-party senders cannot produce our HMAC). `_schedule_inspect` and
`_schedule_cancel` describe every kind; the new `sapiom_dev_agents_schedule_secret`
tool rotates, completes a rotation of, or revokes a webhook secret.

`@sapiom/agent-core` gains the matching `ScheduleKind` members, the webhook /
event fields on `ScheduleSummary`, `CreateScheduleResult`, and
`rotateScheduleSecret` / `completeScheduleSecretRotation` / `revokeScheduleSecret`.

The offline `AUTHORING_INSTRUCTIONS` fallback and the `sapiom-agent-authoring`
skill gain a triggers paragraph teaching the same thing; the served-text change
is version-gated on `@sapiom/mcp` >= 0.15 because older clients are never
offered the new kinds.
