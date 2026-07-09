# @sapiom/analytics-core

## 0.1.0

### Minor Changes

- c245d3a: Publish the collector contract surface and make the emitter ship dark by default.

  - **Ship-dark default**: the emitter no longer has a default endpoint. When neither `endpoint` (config) nor `SAPIOM_ANALYTICS_ENDPOINT` (environment) is set, `createAnalytics` returns a no-op instance — zero network calls, zero disk writes, no first-run notice. The hosted collector URL is now the exported constant `SAPIOM_COLLECTOR_ENDPOINT` (replacing `DEFAULT_ENDPOINT`), which can be passed explicitly to deliver there.
  - **CONTRACT.md**: the public collector wire contract — endpoint, envelope, leniency rules, responses (202/400/413/429), server-stamped fields, identity semantics, producer obligations (including that retried batches must reuse their `event_id`s), event taxonomy seed, and versioning.
  - **Contract fixtures** under `fixtures/contract/{valid,invalid}` (shipped with the package): happy-path batches, one fixture per leniency rule, and the documented 400/413 rejections, each as a self-describing request/expectation descriptor.
  - **`@sapiom/analytics-core/testing`** subpath export: `startMockCollector()` — an in-process HTTP mock of the collector with contract-shaped responses and scriptable failure modes (`down` / `slow` / arbitrary status), usable from any package's tests.
  - **README**: full telemetry disclosure — what is collected, the Sapiom-bound vs third-party content boundary, every opt-out (`SAPIOM_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, programmatic), and the identity file location.

- 3d7eee3: Introduce `@sapiom/analytics-core` — a zero-dependency usage analytics emitter shared by Sapiom SDK packages.

  - `createAnalytics(config)` returns `{ track, flush, shutdown, enabled, anonymousId, sessionId }`; `track()` is a synchronous enqueue that never throws, and `flush()`/`shutdown()` never reject.
  - Consent precedence: programmatic `disabled: true` → `SAPIOM_TELEMETRY_DISABLED=1` → `DO_NOT_TRACK=1` → injected consent provider → default on. When disabled, nothing is written or sent.
  - Anonymous machine identity persisted at `~/.sapiom/analytics.json` (mode 0600, created lazily, corrupt files silently regenerated), plus a one-time first-run notice on stderr.
  - Batched delivery: flush every 3s, at 20 events, or best-effort on process exit; at most one retry per batch (jittered), then silent drop; per-field ~16KB cap flagged via `data._truncated`.
