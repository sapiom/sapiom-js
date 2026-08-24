---
"@sapiom/agent": minor
"@sapiom/agent-runtime": minor
"@sapiom/agent-core": patch
"@sapiom/mcp": patch
---

Make `ctx.shared.set()` an atomic whole-snapshot quota gate. Current hosts now
measure the complete candidate as compact JSON UTF-8 before committing it, so
oversized writes throw `CTX_SHARED_SIZE_LIMIT_EXCEEDED` and retain the previous
state.

Publish the bounded `CTX_SHARED_SERIALIZATION_FAILED` terminal error contract
for circular references, BigInt values, throwing `toJSON` methods, and other
`JSON.stringify` failures. Completion serializers and runners recognize the
new code through the closed platform-error registry and fail the step on its
current attempt without retrying. Ordinary JSON omission and coercion semantics
remain unchanged.
