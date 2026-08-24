---
"@sapiom/agent": minor
"@sapiom/agent-runtime": minor
"@sapiom/agent-core": minor
"@sapiom/mcp": patch
---

Make `ctx.shared.set()` on the SDK's `InMemoryContextStore` an atomic
whole-snapshot quota gate. `runLocal` now constructs this store with step
context; hosts that have not adopted this store version may enforce the contract
only at execution boundaries during rollout. The store measures the complete
candidate as compact JSON UTF-8 before committing it, so oversized writes throw
`CTX_SHARED_SIZE_LIMIT_EXCEEDED` and retain the previous state.

Publish the bounded `CTX_SHARED_SERIALIZATION_FAILED` terminal error contract
for circular references, BigInt values, throwing `toJSON` methods, and other
`JSON.stringify` failures. Completion serializers and runners recognize the
new code through the closed platform-error registry and fail the step on its
current attempt without retrying. Ordinary JSON omission and coercion semantics
remain unchanged.

**Breaking:** `InMemoryContextStore.set()` can now throw synchronously for an
oversized or unserializable candidate. Existing local agents that wrote such
state now fail non-retryably on attempt 0. Migrate bulk state to durable storage
and keep only compact, JSON-compatible values or references in `ctx.shared`. If
a store is seeded with legacy invalid state, replace an offending key with a
value small enough to bring the complete candidate within the quota;
`TypedContextStore` has no `delete()` operation.
