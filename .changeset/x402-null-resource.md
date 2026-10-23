---
"@sapiom/core": patch
---

Stop the x402 type guard throwing on a null V2 `resource`. A 402 body shaped
`{ x402Version: 2, resource: null }` passed the V2 shape check, because
`typeof null === "object"`, and then threw a `TypeError` on the `resource.url`
read. `extractX402` and `extractResource` call the guard without a `try`/`catch`,
so a malformed response from a resource server crashed the caller instead of
being reported as "not an x402 payload".
