---
"@sapiom/mcp": minor
---

App Link management from `sapiom-dev` (SAP-3178). `sapiom_dev_app_publish` publishes, and
only publishes; everything else about a link was REST-only behind an `org.write` key, so a
Studio user who published a webhook receiver could not turn webhooks on from Studio. Three new
tools close that:

- **`sapiom_dev_app_list`** — every App Link in the organization: URL, visibility, whether
  webhooks are on (and the `/hook` URL when they are), spend cap, wake rate limit, wake state.
- **`sapiom_dev_app_settings`** — change `webhooksEnabled`, `visibility` (with `confirmPublic`),
  `dailySpendCapUsd` (or `null` to clear) and `wakeRateLimitPerHour` on a link addressed by
  slug or id. Sends only the fields given; reports the resulting settings and the webhook URL.
- **`sapiom_dev_app_delete`** — delete a link (`confirm: true` required); the URL stops
  resolving and the slug is freed.

A refusal is a sentence, not a status: when the credential lacks `org.write` the error names
the permission and the fields it was asked to change, so the agent tells the user instead of
retrying or reporting a silent success.

The offline `AUTHORING_INSTRUCTIONS` fallback moves to the 2.9 primer, which names the three
tools (version-gated to `@sapiom/mcp` >= 0.15) and teaches that webhooks are off by default
and that `/{org}/{slug}/hook/*` is the receiver third-party signature schemes verify against.
The `sapiom-sandbox-preview` skill and the README gain the same section.
