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
`SAPIOM_COLLECTOR_ENDPOINT`. Note that the emitter **ships dark by default**:
it sends nothing unless an endpoint is configured explicitly (see the README's
telemetry section).

## Request envelope

```jsonc
{
  "events": [
    {
      "event_id": "9f1c7e9e-...",            // uuid v4, client-generated (dedup key)
      "anonymous_id": "b1a2c3d4-...",        // machine UUID — send whenever available
      "session_id": "5e6f7a8b-...",          // producer-defined session
      "event_timestamp": "2026-01-15T10:30:00.000Z", // ISO-8601, client clock
      "source": "ui",                        // ui|harness|mcp|tools|cli|orchestration|langchain|backend
      "event_type": "prompt.submitted",      // canonical naming is dot-separated (see Event naming)
      "user_id": "usr_123",                  // ONLY when signed in (real account identity)
      "sdk_name": "@sapiom/harness",
      "sdk_version": "0.1.0",
      "schema_version": "1",
      "environment": "development",          // optional; server defaults to its own deployment env
      "data": {                              // arbitrary JSON — the payload
        "prompt": "build me a workflow that ...",
        "context": {                         // ambient batch info nests here by convention
          "app_version": "0.1.0", "os": "darwin", "arch": "arm64", "node": "22.4.0"
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

## Conventions in `data`

`data` is free-form (see [leniency](#leniency-rules-the-heart-of-accept-anything)),
but these keys are **promoted by convention**: producers that have the
information SHOULD use these exact names so analysis can rely on them across
producers. The collector stores them verbatim inside `data`; none are
required, and none is ever validated.

### Batch context — `data.context`

Ambient information about the emitting process, identical across every event
in one batch:

```jsonc
"context": { "app_version": "0.1.0", "os": "darwin", "arch": "arm64", "node": "22.4.0" }
```

### Sequence — `data.seq`

A per-session monotonic integer starting at `1`, assigned by the producer
(for the harness, by its local server as each event is minted). Semantics:

- **Scope is one `session_id`** — `seq` resets per session, never global.
- **Order is truth** — use `seq`, not `event_timestamp`, for intra-session
  ordering; client clocks are neither monotonic nor comparable across
  machines.
- **Gaps mean loss** — a missing value in an otherwise contiguous run is a
  dropped or never-delivered event, which makes per-session loss directly
  measurable.

The collector stores `seq` verbatim and never reorders, dedupes, or backfills
on it — `event_id` remains the sole dedup key.

### Harness dimensions

Harness-sourced events (`source: "harness"`) carry three first-class grouping
keys in `data`. Other producers omit them.

| key | meaning |
|---|---|
| `data.harness_session_id` | the harness's own session id — one pty running one agent in one directory |
| `data.agent_session_id` | the agent's native session id (Claude session uuid / Codex rollout id); `null` until known |
| `data.harness_kind` | which agent the harness drives: `claude-code` \| `codex` |

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

## Event naming

Canonical `event_type` is **dot-separated** `<noun>.<verb-or-state>` —
`session.start`, `prompt.submitted`, `tool.call`, `turn.completed`,
`session.end`. The `source` column disambiguates the same name across
producers: a `tool.call` from `harness` and a `tool.call` from `mcp` are
distinct rows told apart by `source`, never by renaming the event.

Naming is a convention, not a validation: **leniency is unchanged** — the
collector stores any `event_type` string verbatim, including legacy
underscore names. New producers SHOULD emit dot-separated names.

## Event taxonomy seed (non-exhaustive by design)

| source | event_type examples |
|---|---|
| `harness` | `session.start`, `prompt.submitted`, `tool.call`, `turn.completed`, `session.end` |
| `ui` | `session.started`, `session.ended`, `consent.granted`, `consent.declined`, `prompt.submitted`, `keystrokes.batch`, `button.clicked`, `harness.selected`, `skill.viewed`, `skill.used`, `mcp_install.triggered`, `preview.triggered`, `doctor.check`, `doctor.fix_applied` |
| `tools` | `capability.call` |
| `mcp` | `mcp.tool_call` |
| `cli` | `cli.command`, `first_run.notice_shown`, `telemetry.opt_out` |
| `orchestration` | `workflow.deploy`, `workflow.run`, `workflow.step` |
| `langchain` | `model.call_meta`, `tool.call_meta` |

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
