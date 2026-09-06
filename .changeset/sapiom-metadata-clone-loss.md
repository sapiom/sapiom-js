---
"@sapiom/fetch": patch
---

Fixed `__sapiom` per-request metadata (e.g. `{ enabled: false }`) being
silently lost when a `Request` instance was passed as `fetch`'s `input`.

`sapiomFetch` reconstructs the request via `new Request(input, init)`
before reading `__sapiom`. Native `Request` cloning does not preserve
custom properties, so a `__sapiom` override set on the original `Request`
was dropped before it could be read - the documented per-request bypass
(e.g. `request.__sapiom = { enabled: false }`) silently had no effect.

`__sapiom` is now captured from the original `input` before cloning and
re-attached to the clone, including after the identity-header re-wrap
later in the same function (the same class of loss, one function down).

Deliberately scoped to the reproduction reported in the issue and this
identical pattern within `sapiomFetch` itself. `handleAuthorization`
(`interceptors.ts`) does its own internal `Request` re-wrap before
returning, which could still drop `__sapiom` for a caller relying on it
past the authorization step (e.g. at payment-retry time) - left as a
separate, deeper propagation concern rather than folded into this fix.
