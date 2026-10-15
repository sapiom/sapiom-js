---
"@sapiom/tools": patch
---

Sandbox methods that threw a bare `Error` on a non-2xx (create, writeFile,
readFile, the exec paths, getProcess, createPublicUrl, deployPreview, destroy)
now throw `SandboxHttpError`, with a numeric `status` and `retryAfterMs`. The
message is unchanged and the class still extends `Error`.

`Transport.fetch` keeps the caller's headers when they are passed as a `Headers`
instance or a tuple array; a spread used to drop them.

`Retry-After` is parsed by one RFC 9110 parser on the shared non-2xx path. A
delay past a safe integer, or an HTTP-date more than a day out, is ignored
rather than trusted. The sandbox multipart retry loop used its own looser copy,
which read `"1.5"` as a delay.

Internally, the capability namespaces now share one non-2xx path; each keeps its
own error class and message. Executions still parse their own error body and
`Retry-After` for now.
