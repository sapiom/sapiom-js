---
"@sapiom/tools": minor
---

Add email reputation reads and typed webhook events (SAP-4021).

- `email.metrics.rates()` returns the organization's rolling 24-hour bounce and complaint rates and the send count behind them. It needs the organization's own key; a customer-tenant key gets a 403.
- `email.webhooks.list()` and `email.webhooks.get(id)` read your registrations. Neither returns the signing secret.
- `EmailEventType` lists every subscribable event, and `EmailEvent` is the union of delivered payloads. Narrow on `eventType`. `message.bounced` carries `bounceType` / `bounceSubType`, and `message.complained` carries `complaintType` / `complaintSubType`.

**Type change:** `CreateWebhookInput.eventType` and `Webhook.eventType` are now `WebhookEventType` (`EmailEventType | "*"`) instead of `string`. A call that passes a plain `string` variable needs a cast or a narrower type. The gateway already rejected any value outside this set with a 400.

Requires the matching Sapiom gateway release (sapiom/Sapiom, SAP-4021). Against an older gateway, `webhooks.list` / `webhooks.get` / `metrics.rates` return 404, and delivered events have no `eventType` or bounce/complaint types.
