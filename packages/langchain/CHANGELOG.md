# @sapiom/langchain

## 0.5.1

### Patch Changes

- d70e60a: 402 payment-retries no longer emit a separate error event; success carries payment_retried.

  Previously, a pay-gated MCP tool call emitted two `tool.call` analytics events: an `error` event for the expected 402 bounce, then a `success` event for the paid retry. This doubled apparent error rates in dashboards.

  **What changes:**
  - The expected-402 bounce emits nothing at bounce time.
  - The final outcome emits exactly ONE `tool.call` event per logical call.
  - When a payment retry happened, the event carries `payment_retried: true` in `data` — friction stays visible as a field, never as a second event.
  - If the retry also fails (payment succeeded but call failed), exactly one error event emits with `payment_retried: true`.
  - Non-payment errors are unaffected: one error event, no `payment_retried` field.

  Net invariant: one logical tool call = exactly one `tool.call` event, always.

- Updated dependencies [95bfcd1]
- Updated dependencies [bf44229]
- Updated dependencies [dab6d44]
- Updated dependencies [ebfa0bc]
  - @sapiom/analytics-core@0.2.1

## 0.5.0

### Minor Changes

- 2a97d64: Emit metadata-only `model.call` / `tool.call` usage analytics from the middleware wrap hooks, with a structurally enforced privacy boundary.

  - `wrapModelCall` / `wrapToolCall` now enqueue one `@sapiom/analytics-core` event per underlying invocation (`source: "langchain"`): model name, provider, duration, token counts when available, tool NAME, and success/error class. Emission is a synchronous enqueue that never throws or blocks, and ships dark unless an analytics endpoint is configured; `SAPIOM_TELEMETRY_DISABLED=1` / `DO_NOT_TRACK=1` opt out entirely.
  - HARD EXCLUSIONS enforced structurally by an allow-list payload builder (not a redaction filter): no prompt text, no completions, no tool arguments, no tool results, no message content, no error messages — verified by sentinel-based redaction boundary tests against a mock collector.
  - Realigned `langchain` dev/test tooling to the current 1.x line (`~1.5.3` + `@langchain/core ~1.2.1`) and adopted the `createMiddleware()` factory required by langchain 1.5 branded middleware types; public API and behavior unchanged.
  - The `langchain` peer dependency floor is now ≥1.5.0 (`createMiddleware()` was introduced in 1.5; earlier versions fail at runtime).

### Patch Changes

- Updated dependencies [3f25008]
- Updated dependencies [55462b3]
  - @sapiom/analytics-core@0.2.0

## 0.4.1

### Patch Changes

- c0fef6d: Mark as deprecated. Sapiom has moved to a new agent-first platform. These packages remain published and receive maintenance fixes only — new projects should build on the new packages (`@sapiom/agent` and `@sapiom/tools`, with the `@sapiom/cli` and `@sapiom/mcp` developer tools). Adds a deprecation notice to each README.

## 0.4.0

### Minor Changes

- 658e8fb: New: SDK Identity Token Lifecycle. Adds automatic Sapiom-Identity JWT management across all SDK packages. The SDK lazily fetches identity tokens from POST /v1/auth/tokens, caches them in-memory, and attaches the Sapiom-Identity header to requests whose target hostname matches the token's aud claim (direct or subdomain match).

### Patch Changes

- Updated dependencies [658e8fb]
  - @sapiom/core@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [c9ad2cb]
  - @sapiom/core@0.4.0

## 0.3.0

### Minor Changes

- 8423815: implement `@sapiom/mcp`, minor code formatting

### Patch Changes

- Updated dependencies [8423815]
  - @sapiom/core@0.3.0

## 0.2.2

### Patch Changes

- 797d633: Fix ESM imports in Node.js by adding `{"type": "module"}` package.json to dist/esm folders
- Updated dependencies [797d633]
  - @sapiom/core@0.2.2

## 0.2.1

### Patch Changes

- fix: add .js extensions to ESM imports for Node.js compatibility

  Node.js ESM requires explicit .js extensions in relative imports. This change ensures all packages work correctly when imported as ES modules in Node.js environments.

- Updated dependencies
  - @sapiom/core@0.2.1

## 0.2.0

### Minor Changes

- 19338bb: Add x402 V2 protocol support
  - Add V1/V2 union types (`X402ResponseV1`, `X402ResponseV2`, etc.) in `@sapiom/core`
  - Add type guards (`isV2Response`, `isV1Requirement`) and helpers (`getPaymentAmount`, `getResourceUrl`)
  - `PaymentRequiredError` now exposes `x402Version` and `isV2()`/`isV1()` methods
  - Axios/fetch interceptors send `PAYMENT-SIGNATURE` header for V2, `X-PAYMENT` for V1
  - Full backward compatibility with V1 protocol maintained

### Patch Changes

- Updated dependencies [19338bb]
  - @sapiom/core@0.2.0

## 0.1.2

### Patch Changes

- 5593157: Update documentation links, sapiom.com to sapiom.ai
- Updated dependencies [5593157]
  - @sapiom/core@0.1.2

## 0.1.1

- First public release

## 0.1.0

### Initial Release

- LangChain v1.x middleware integration
- Automatic agent lifecycle tracking
- Model call tracking with token estimation
- Tool call pre-authorization support
- Session-based cost tracking
- Compatible with LangChain v1.0+
