# Sapiom Analytics Collector Contract — v1

The wire contract between analytics producers (this package, every Sapiom SDK
package built on it, and anything else that wants to emit) and the Sapiom
analytics collector. This document is the public source of truth: producers
may rely on everything described here, and changes are additive-only — any
semantic change bumps `schema_version` (see [Versioning](#versioning)).

## Endpoint

```
POST https://api.sapiom.ai/v1/analytics/collector
Content-Type: application/json
x-sapiom-api-key: <optional — enables server-side organization enrichment>
```

Batch-only. A single event is a batch of one.

Authentication is optional and does exactly one thing: a **valid**
`x-sapiom-api-key` lets the collector attach the organization behind the key
to the events (see [Server-stamped fields](#server-stamped-fields-never-client-trusted)).
An invalid or missing key never causes a rejection.

This URL is exported by `@sapiom/analytics-core` as the constant
`SAPIOM_COLLECTOR_ENDPOINT` and is the emitter's **default endpoint**: an
emitter with no explicit `endpoint` configured delivers here, unless the
user has opted out (see the README's telemetry section).

## Request envelope

```jsonc
{
  "events": [
    {
      "event_id": "9f1c7e9e-...",            // uuid v4, client-generated (dedup key)
      "anonymous_id": "b1a2c3d4-...",        // machine UUID — send whenever available
      "session_id": "5e6f7a8b-...",          // producer-defined session
      "event_timestamp": "2026-01-15T10:30:00.000Z", // ISO-8601, client clock — data.seq is authoritative for ordering when present
      "source": "ui",                        // ui|mcp|tools|cli|agent|langchain|backend|harness
      "event_type": "prompt.submitted",
      "user_id": "usr_123",                  // ONLY when signed in (real account identity)
      "sdk_name": "@sapiom/harness",
      "sdk_version": "0.1.0",
      "schema_version": "1",
      "environment": "development",          // optional; server defaults to its own deployment env
      "data": {                              // arbitrary JSON — the payload
        "prompt": "build me a workflow that ...",
        "context": {                         // ambient info nests here by convention
          "os": "darwin", "node": "22.4.0"
        }
      }
    }
  ]
}
```

## Leniency rules (the heart of "accept anything")

The ONLY hard requirement is a parseable JSON body.

| Situation | Behavior |
|---|---|
| `events` key absent or not an array | acknowledged with `{"accepted":0,"dropped":0}`; never rejected |
| Missing `event_id` | server generates one |
| Missing timestamps | server stamps `received_at`; `event_timestamp` defaults to it |
| Missing identity fields | ingested anyway (`anonymous_id` null is legal, discouraged) |
| Unknown top-level keys on an event | folded into `data` — never rejected |
| Unknown `source`/`event_type` values | stored verbatim |
| `data` not an object | wrapped as `{ "value": <sent> }` |
| Invalid API key header | ignored; event ingests as anonymous |

## Responses

| Code | When | Producer behavior |
|---|---|---|
| `202 {"accepted":n,"dropped":m}` | anything parseable | fire-and-forget |
| `400` | body is not JSON | drop batch |
| `413` | body > 1 MB or > 500 events | split or drop; never loop |
| `429` | IP throttled | drop batch (≤1 retry with jitter permitted) |

Producers MUST treat every response as non-actionable beyond the single
optional retry. Analytics must never block, throw into, or degrade the host
application.

## Server-stamped fields (never client-trusted)

`received_at` (the collector's authoritative arrival time), `ip`,
`user_agent`, `collector_version`, and — only when a valid
`x-sapiom-api-key` is presented — `org_id` and `api_key_id`. Client-claimed
`org_id`/`api_key_id` in the body are ignored (folded into `data`).
Client-claimed `user_id` passes through as sent.

## Identity semantics

- `anonymous_id` — machine-scoped UUID, generated once and persisted at
  `~/.sapiom/analytics.json` (mode 0600). Present on every event from every
  producer. A grouping key for analysis, NOT an auth identity.
- `user_id` — present only when a signed-in identity is known (e.g. a
  `sapiom login` session). Means a real, identifiable account usable for
  lifecycle actions. Never synthesized.
- `session_id` — producer-defined: UI harness = one browser/agent session;
  SDK = one process lifetime; CLI = one command invocation.

## Producer obligations

1. Batch client-side: flush every ~3 s, or at 20 events, or best-effort on
   process exit.
2. At most ONE retry per batch; then silent drop. **Retried batches MUST
   reuse the same `event_id`s** — deduplication in analytics storage is keyed
   on `event_id`, and server-minted IDs (assigned when a producer omits
   `event_id`) are fresh per request, so such retries double-insert.
3. Never throw, never block the host app, never log louder than debug on
   failure.
4. Respect consent before enqueueing anything: `SAPIOM_TELEMETRY_DISABLED=1`,
   `DO_NOT_TRACK=1`, the producer's programmatic opt-out, and any stored
   consent state the producer keeps.
5. Size-cap large values before sending (per-field ~16 KB, truncation flagged
   in `data._truncated`).
6. Third-party boundary: payload content (arguments/results) only for
   Sapiom-bound calls; calls to third-party tools or services (e.g.
   user-supplied tools wrapped by a Sapiom integration) send metadata only —
   names, durations, statuses — never arguments or content.

## Harness & session telemetry conventions

Everything in this section is convention, not enforcement: it all rides
inside `data`, and the collector validates none of it. The conventions
exist so independent producers converge on the same shapes and
cross-producer analysis stays cheap.

**Per-session `seq`.** Producers that manage sessions locally (e.g. the dev
harness) MAY assign each session's events a monotonic sequence number
starting at 1, carried as `data.seq`. Within one `session_id`, `seq` order
is authoritative — when it disagrees with `event_timestamp` (a client
clock), trust `seq`. It is producer-assigned and stored verbatim; the
collector never renumbers, and `seq` values from different sessions are not
comparable. If a producer restarts mid-session, `seq` resets — consumers
should treat a `seq` decrease as a restart boundary, not loss.

For the harness specifically: `seq` indexes the harness's local capture
stream; some locally-sequenced event kinds are not forwarded remotely, so
remote streams have **expected gaps** — duplicates are the anomaly signal,
not gaps. (Verified against production data 2026-07-09.)

**Batch context.** `data.context` MAY carry `app_version`, `os`, `arch`,
and `node`, stamped once per batch by the producer — the conventional
nesting point for ambient info shown in the
[request envelope](#request-envelope).

**Session dimensions.** Harness-style producers SHOULD carry these on every
event so sessions can be joined and sliced across event types:

| field | meaning |
|---|---|
| `data.harness_session_id` | the harness's own session |
| `data.agent_session_id` | the agent session the harness is driving |
| `data.harness_kind` | which kind of harness emitted the event |

**Canonical event naming.** Event names are dot-separated
`<noun>.<verb/state>`: `session.start`, `prompt.submitted`,
`capability.call`, `command.run`. The envelope `source` field disambiguates
same-named events from different producers — `tool.call` from `mcp` is not
`tool.call` from `langchain`. This is guidance for producers, not a gate:
the collector stores `event_type` verbatim either way.

## Event taxonomy seed (non-exhaustive by design)

| source | event_type examples |
|---|---|
| `ui` | `session.start`, `session.end`, `consent.granted`, `consent.declined`, `prompt.submitted`, `keystrokes.batch`, `button.click`, `harness.selected`, `skill.viewed`, `skill.used`, `mcp.install`, `preview.triggered`, `doctor.check`, `doctor.fix_applied` |
| `tools` | `capability.call` |
| `mcp` | `tool.call` |
| `cli` | `command.run`, `notice.shown`, `telemetry.opt_out` |
| `agent` | `workflow.deploy`, `workflow.run`, `workflow.link`, `step.start`, `step.complete`, `step.error` |
| `langchain` | `model.call`, `tool.call` — pay-gated calls emit one event; `payment_retried: true` marks the 402-retry path |
| `harness` | `session.start`, `prompt.submitted`, `tool.call`, `turn.completed`, `session.end` |

New event types require no contract change — send them.

## Versioning

`schema_version` starts at `"1"`. Envelope changes are additive-only;
anything semantic bumps the version and both sides keep accepting/producing
prior versions.

## Contract fixtures

Machine-readable examples of this contract ship with the package under
[`fixtures/contract/`](./fixtures/contract):

- `valid/` — happy-path batches plus one fixture per leniency-table rule;
  all expect `202`.
- `invalid/` — the documented rejections: a non-JSON body and an empty body
  (`400`), and a 501-event batch (`413`). The 1 MB body-size variant of the
  `413` rule is not fixtured; it behaves identically. `429` is rate-limiting
  behavior, a property of traffic rather than of any single body, so it has
  no fixture either.

Each fixture is a descriptor:

```jsonc
{
  "name": "missing-event-id",          // matches the filename
  "rule": "...",                       // the contract rule it exercises
  "description": "...",
  "request": {
    "headers": { "...": "..." },       // optional extra headers
    "body": { "events": [ /* ... */ ] } // JSON body — XOR with rawBody
    // "rawBody": "..."                // literal body for unparseable payloads
  },
  "expected": {
    "status": 202,
    "response": { "accepted": 1, "dropped": 0 }, // optional, exact match
    "notes": "..."                     // optional server-side effects to assert
  }
}
```

Collector implementations and producer instrumentation tests should replay
these fixtures verbatim: POST `request.rawBody` (or the serialized
`request.body`) with `request.headers` and assert `expected.status` (and
`expected.response` where pinned).

## Testing against the contract

`@sapiom/analytics-core/testing` exports `startMockCollector()`, an
in-process HTTP mock of this contract with scriptable failure modes
(down / slow / arbitrary status) for producer tests. See the README.
