---
"@sapiom/tools": minor
---

Execution results now expose the server's serving disclosure, in SKU vocabulary.

- `models.run` (`ModelRunOutcome`): new optional `servedClass` + `lane` (wire `served_class`, `lane`) — the billing class (size) the run's label resolved to and the lane it executed in. Never a model or provider id. **The existing `costUsd` field is deprecated and now nullable**: servers report null (the customer dollar amount is the metering pipeline's, summed on run views — not a synchronous edge-computed figure); older servers may still send a number, which maps through unchanged.
- `models.coding.run` (`CodingRunOutcome`): new optional `servedClass` / `lane` / deprecated `costUsd` — currently reported as null by coding servers (unknown), reserved for parity across result shapes.
- `llm.run` / `llm.redeem` / `llm.callSession`: new `LlmDisclosure` type describing the `served_class` / `lane` fields the server injects top-level into raw `/v2` non-streaming response bodies (streams carry the same data as `x-sapiom-served-class` / `x-sapiom-lane` response headers), plus a `readDisclosure()` helper returning the camel-cased `LlmDisclosureResult`. The response `model` field is unchanged and keeps echoing the requested label.
- All result shapes reserve an optional `degradation` annotation, typed `unknown` (server-defined shape, not yet stable; absent on a clean execution).

All additions are optional/nullable: existing consumers compile and run unchanged (note `ModelRunOutcome.costUsd` widens `number` → `number | null`). On results from older servers the mappers and `readDisclosure` return `servedClass`/`lane` as `null` (unknown); `degradation` and the raw body fields are simply absent.
