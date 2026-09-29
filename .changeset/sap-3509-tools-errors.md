---
"@sapiom/tools": patch
---

Sandbox methods that threw a bare `Error` on a non-2xx (create, writeFile,
readFile, the exec paths, getProcess, createPublicUrl, deployPreview, destroy)
now throw `SandboxHttpError`, with a numeric `status` and `retryAfterMs`. The
message is unchanged and the class still extends `Error`.

`Transport.fetch` keeps the caller's headers when they are passed as a `Headers`
instance or a tuple array; a spread used to drop them.

`Retry-After` is parsed by one RFC 9110 parser for every capability, and a delay
past a safe integer or more than a day out is ignored rather than trusted. The
sandbox multipart retry loop used its own looser copy, which read `"1.5"` as a
delay.

Internally, every capability namespace now shares one non-2xx path; each keeps
its own error class and message.
