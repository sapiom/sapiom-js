# @sapiom/agent-map

## 0.2.0

### Minor Changes

- b052979: Add a browser-safe Studio host protocol and an offline MCP capability descriptor.
  The probe reports the installed package identity without starting the server; map
  features remain inactive until their implementations and Studio activation land.
- d9d6b13: Share Agent Map contracts without changing Studio behavior or saved state.
- 8a77b06: Share project identity, catalog locking, and canonical path matching while Studio retains discovery orchestration.

  Resolve paths asynchronously with briefly cached root probes, isolate unrelated filesystem failures, and preserve ownership errors before Studio registration or session creation.

- 5e9aacd: Share atomic map authoring and persistence, preserving the complete planning aggregate and Studio callbacks.
- 5b61bac: Share map schemas, graph validation, and immutable version helpers.
