# @sapiom/analytics-core

Zero-dependency usage analytics emitter shared by Sapiom SDK packages.

Sapiom packages use it to send anonymous usage events (which commands and
capabilities are used, SDK name/version, coarse runtime info) to
`https://api.sapiom.ai/v1/analytics/collector` so we can understand real-world
usage and improve the SDK. It is designed to be invisible to the host
application:

- **Never throws, never blocks.** `track()` is a synchronous enqueue; every
  failure inside analytics is silently swallowed.
- **Batched and bounded.** Events flush every 3 seconds, at 20 events, or
  best-effort on process exit. A failed batch is retried at most once, then
  dropped. Oversized fields are truncated (flagged with `data._truncated`).
- **Zero runtime dependencies.** Node built-ins only.

## Consent and opting out

Analytics is on by default. The first-ever tracked event on a machine prints a
one-line notice to stderr so it is never silent.

Opt out in any of these ways (highest precedence first):

1. Programmatically: `createAnalytics({ ..., disabled: true })`
2. `SAPIOM_TELEMETRY_DISABLED=1` in the environment
3. `DO_NOT_TRACK=1` in the environment (the ecosystem-wide convention)

When opted out, nothing is sent, nothing is written to disk, and zero network
calls are made.

## What is stored locally

A single file, `~/.sapiom/analytics.json` (permissions `0600`), holding a
random anonymous machine id and the first-run-notice marker. It contains no
personal information. Delete it at any time to reset the identity.

## Usage

```typescript
import { createAnalytics } from "@sapiom/analytics-core";

const analytics = createAnalytics({
  source: "cli",
  sdkName: "@sapiom/cli",
  sdkVersion: "1.0.0",
});

analytics.track("cli_command", { command: "dev" });

await analytics.flush(); // best-effort send, never rejects
await analytics.shutdown(); // flush + stop timers, never rejects
```

`track(eventType, data?, overrides?)` accepts an arbitrary event type, a JSON
payload, and optional per-event envelope overrides (for example
`{ user_id: "usr_123" }` when a signed-in identity is known).

## Status

This package is the shared emitter used by other `@sapiom/*` packages; its
API may still evolve. A fuller description of the event schema and data
handling will ship alongside the packages that adopt it.

## License

MIT
