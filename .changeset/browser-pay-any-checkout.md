---
"@sapiom/browser-pay": minor
---

`AttachOptions.profileId` is optional. Without it the interceptor relays a paused request to any checkout: the relay sends it to its own URL when that is https to a public host and finds the card fields by the placeholder's values. Without a profile every header is forwarded except the connection's, `cookie`, and the browser's `sec-fetch-*` and `sec-ch-*` hints. A paused request with a header the relay can't take (more than 32 headers, a name over 128 characters or a value over 8192), with or without a profile, fails with the new `FailureReason` `headers_unrelayable` instead of being relayed without that header. An empty `profileId` is refused at attach.
