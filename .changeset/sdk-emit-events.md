---
"@sapiom/agent-core": minor
"@sapiom/cli": minor
"@sapiom/mcp": minor
---

Emit custom events from the SDK, the CLI and the MCP — the start verb next to
`signal`'s resume verb.

`emitEvent({ type, payload, eventId? })` posts to `POST /v1/workflows/events`
and returns the receipt verbatim: `{ receiptId, outcome, duplicate, fireIds }`.
It fans out by type to every active `event` trigger the tenant armed and starts
0..N new runs. `outcome: "unmatched"` is a success, not an error — nothing
subscribes to that type. `eventId` is the sender's dedup identity, so reposting
it returns the original receipt and starts nothing new; omit it and every call
is a distinct event. `sapiom agents emit <type> --payload <json> [--event-id
<id>]` and `sapiom_dev_agents_emit_event` wrap it, and `parseEventPayload`
rejects a payload that is not a JSON object, which the run-input fold would
otherwise drop silently.

Events start runs, signals resume them, so `signal()` stays the resume verb and
now surfaces the server's `message` next to `matched` — `matched` counts the
runs that actually resumed, so it under-reports a partial fanout and a `0` does
not prove nothing was waiting.
