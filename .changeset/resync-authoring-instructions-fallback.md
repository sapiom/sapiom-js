---
"@sapiom/mcp": patch
---

Re-sync the offline `AUTHORING_INSTRUCTIONS` fallback with the server's canonical
primer. The fallback is what the server serves when its startup fetch of
`GET /v1/mcp/instructions` fails, and it had drifted two content releases behind — so
exactly the sessions with no other source of truth were told App Links do not exist:
no durable-sharing paragraph, no `sapiom_dev_app_publish`, no hosted or REST publish
surface. It also still described the older single-alias framing of the hosted
capability MCP, which now lives under its own `sapiom-direct` alias.

The two copies are now byte-identical, and a frozen sha-256 in `instructions.test.ts`
— the same digest the server-side spec pins for this content release — fails CI on a
one-sided edit instead of letting them drift silently a third time.
