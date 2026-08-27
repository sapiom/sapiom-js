---
"@sapiom/agent": minor
"@sapiom/agent-core": patch
"@sapiom/tools": patch
---

Step code can now tell a local trace from a deployed run, and the stub Postgres DSN no longer points at a real host.

`AgentExecutionContext` gains `local?: boolean` — `true` under `run_local`, absent on a deployed run. That absence is deliberate: `input.dryRun ?? ctx.local` reads as live in production with nothing set, so gating raw I/O needs no change to how an agent is deployed.

Use it for the I/O `run_local` cannot stub — a raw Postgres socket, third-party HTTP, any client holding its own connection:

```ts
const dryRun = input.dryRun ?? ctx.local ?? false;
```

Capability calls (`ctx.sapiom.*`) are already stubbed locally and need no guard.

Separately, the stub `database.get` / `database.create` DSN now uses a host under the RFC 6761 `.invalid` TLD instead of `localhost`. A template that dialed the old DSN reached whatever Postgres happened to be listening on the author's own machine and failed with an opaque TLS error; it now fails at DNS resolution, before any socket is opened, with the stub named in the message.
