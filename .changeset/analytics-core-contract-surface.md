---
"@sapiom/analytics-core": minor
---

Publish the collector contract surface and make the emitter ship dark by default.

- **Ship-dark default**: the emitter no longer has a default endpoint. When neither `endpoint` (config) nor `SAPIOM_ANALYTICS_ENDPOINT` (environment) is set, `createAnalytics` returns a no-op instance — zero network calls, zero disk writes, no first-run notice. The hosted collector URL is now the exported constant `SAPIOM_COLLECTOR_ENDPOINT` (replacing `DEFAULT_ENDPOINT`), which can be passed explicitly to deliver there.
- **CONTRACT.md**: the public collector wire contract — endpoint, envelope, leniency rules, responses (202/400/413/429), server-stamped fields, identity semantics, producer obligations (including that retried batches must reuse their `event_id`s), event taxonomy seed, and versioning.
- **Contract fixtures** under `fixtures/contract/{valid,invalid}` (shipped with the package): happy-path batches, one fixture per leniency rule, and the documented 400/413 rejections, each as a self-describing request/expectation descriptor.
- **`@sapiom/analytics-core/testing`** subpath export: `startMockCollector()` — an in-process HTTP mock of the collector with contract-shaped responses and scriptable failure modes (`down` / `slow` / arbitrary status), usable from any package's tests.
- **README**: full telemetry disclosure — what is collected, the Sapiom-bound vs third-party content boundary, every opt-out (`SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, programmatic), and the identity file location.
