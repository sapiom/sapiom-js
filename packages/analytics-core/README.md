# @sapiom/analytics-core

Zero-dependency usage analytics emitter shared by Sapiom SDK packages.

Sapiom packages use it to send usage events to the Sapiom analytics collector
so we can understand real-world usage and improve the SDK. It is designed to
be invisible to the host application:

- **Never throws, never blocks.** `track()` is a synchronous enqueue; every
  failure inside analytics is silently swallowed.
- **Batched and bounded.** Events flush every 3 seconds, at 20 events, or
  best-effort on process exit. A failed batch is retried at most once, then
  dropped. Oversized fields are truncated (flagged with `data._truncated`).
- **Zero runtime dependencies.** Node built-ins only.
- **Ships dark by default.** Unless an endpoint is explicitly configured,
  nothing is sent anywhere — see below.

## Telemetry: what, where, and how to turn it off

This section is the complete disclosure for the analytics this package can
emit. The full wire contract lives in [CONTRACT.md](./CONTRACT.md).

### What is collected

Each event is a small JSON envelope:

- **What happened**: an event name (e.g. `cli_command`, `capability_call`)
  and a JSON payload describing it.
- **Which software sent it**: the emitting package's name and version, the
  surface it belongs to (`cli`, `tools`, `mcp`, ...), and a schema version.
- **Coarse context**: timestamps, and by convention ambient info like OS
  platform and Node version nested under `data.context`.
- **Identity** (see below): a random machine id, a per-process session id,
  and — only when you are signed in to Sapiom — your account's user id.

### The Sapiom-bound vs third-party boundary

- For calls **to Sapiom's own APIs**, events may include the content of the
  call (for example, which capability was invoked and with what parameters).
- For calls **to third-party tools or services** that a Sapiom integration
  merely wraps (for example, your own tools passed through a Sapiom SDK),
  events carry **metadata only** — names, durations, statuses — never the
  arguments, results, or any other content.

Analytics never reads your environment variables, credentials, or files
beyond its own identity file described below.

### Opting out

Any of these disables analytics entirely (highest precedence first):

1. Programmatically: `createAnalytics({ ..., disabled: true })` — packages
   built on this emitter expose their own equivalent switch in their options.
2. `SAPIOM_TELEMETRY_DISABLED=1` in the environment.
3. `DO_NOT_TRACK=1` in the environment (the ecosystem-wide convention).

When opted out, nothing is sent, nothing is written to disk, zero network
calls are made — and no notice is printed.

When analytics is active, the first-ever tracked event on a machine prints a
one-line notice to stderr, so collection is never silent.

### What is stored locally

A single file, `~/.sapiom/analytics.json` (permissions `0600`), holding a
random anonymous machine id and the first-run-notice marker. It contains no
personal information. Delete it at any time to reset the identity; it is
never created while analytics is disabled or unconfigured.

### Current status: ships dark

The emitter has **no default endpoint**. Unless an endpoint is explicitly
configured — `endpoint` in the config, or the `SAPIOM_ANALYTICS_ENDPOINT`
environment variable (used by tests) — `createAnalytics` returns a no-op
instance: zero network calls, zero disk writes, no first-run notice. The
hosted collector URL is exported as the constant `SAPIOM_COLLECTOR_ENDPOINT`
for when you (or a future release of this package) want to send there.

## Usage

```typescript
import { createAnalytics } from "@sapiom/analytics-core";

const analytics = createAnalytics({
  source: "cli",
  sdkName: "@sapiom/cli",
  sdkVersion: "1.0.0",
  // No endpoint → a silent no-op. To actually deliver:
  // endpoint: SAPIOM_COLLECTOR_ENDPOINT,
});

analytics.track("cli_command", { command: "dev" });

await analytics.flush(); // best-effort send, never rejects
await analytics.shutdown(); // flush + stop timers, never rejects
```

`track(eventType, data?, overrides?)` accepts an arbitrary event type, a JSON
payload, and optional per-event envelope overrides (for example
`{ user_id: "usr_123" }` when a signed-in identity is known).

## Testing utilities

`@sapiom/analytics-core/testing` ships an in-process mock collector — a real
HTTP server on a random loopback port with contract-shaped responses and
scriptable failure modes — for use in any package's tests:

```typescript
import { createAnalytics } from "@sapiom/analytics-core";
import { startMockCollector } from "@sapiom/analytics-core/testing";

const collector = await startMockCollector();
const analytics = createAnalytics({
  source: "tools",
  sdkName: "@sapiom/tools",
  sdkVersion: "1.0.0",
  endpoint: collector.url,
});

analytics.track("capability_call", { capability: "search" });
await analytics.flush();

expect(collector.events()).toHaveLength(1);

collector.setMode({ kind: "status", status: 500 }); // or "down", "slow"
// ... assert your instrumentation degrades silently ...

await collector.close();
```

## Contract and fixtures

- [CONTRACT.md](./CONTRACT.md) — the collector wire contract (envelope,
  leniency rules, responses, producer obligations).
- [`fixtures/contract/`](./fixtures/contract) — machine-readable request
  fixtures (valid + invalid) for contract conformance tests, shipped with
  the package.

## License

MIT
