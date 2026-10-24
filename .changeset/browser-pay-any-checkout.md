---
"@sapiom/browser-pay": minor
---

`AttachOptions.profileId` is optional. Without it the interceptor relays a paused request to any checkout: the relay sends it to its own URL when that is https to a public host and finds the card fields by the placeholder's values. Without a profile every header is forwarded except the connection's, `cookie`, and the browser's `sec-fetch-*` and `sec-ch-*` hints, at most 32. An empty `profileId` is refused at attach.
