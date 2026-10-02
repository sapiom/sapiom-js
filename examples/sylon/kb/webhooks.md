# Webhooks

Relaybox sends a webhook for every event a workspace subscribes to under
**Settings → Webhooks**. Each delivery is an HTTPS `POST` with a JSON body and an
`X-Relaybox-Signature` header (HMAC-SHA256 of the raw body with the endpoint's signing secret).

- Your endpoint must answer `2xx` within 10 seconds. Anything else counts as a failure.
- Failed deliveries retry 8 times with exponential backoff over about 24 hours.
- After 50 consecutive failures the endpoint is paused and the workspace owner gets an email.
  Fix the endpoint, then click **Resume** on the endpoint page; paused events are replayed.
- **Redeliver** on any event in the delivery log sends it again immediately.
- A signature mismatch is almost always a body that was parsed and re-serialized before
  verification. Verify against the raw bytes.
- Rotating the signing secret keeps the old secret valid for 24 hours.
