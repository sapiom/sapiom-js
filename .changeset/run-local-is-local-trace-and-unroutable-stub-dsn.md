---
"@sapiom/agent": minor
"@sapiom/agent-core": patch
"@sapiom/tools": patch
---

Step code can now tell a local trace from a deployed run, and the stub Postgres DSN no longer points at a host that might answer.

`AgentExecutionContext` gains `isLocalTrace?: boolean` — `true` under `run_local`, and set by nothing else. The deployed step runner does not set it, so `input.dryRun ?? ctx.isLocalTrace` reads as live in production; the name is qualified precisely because that absence is load-bearing.

Use it for the I/O `run_local` cannot stub — a raw Postgres socket, third-party HTTP, any client holding its own connection. Resolve it once in the entry step and carry it in `ctx.shared`, since `input` downstream is the previous step's output:

```ts
// entry step
const dryRun = input.dryRun ?? ctx.isLocalTrace ?? false;
ctx.shared.set("dryRun", dryRun);
```

An explicit `{ "dryRun": false }` still forces the live path. Capability calls (`ctx.sapiom.*`) are already stubbed locally and need no guard.

Separately, the stub `database.get` / `database.create` DSN now uses a host in the reserved `.invalid` TLD (RFC 6761) instead of `localhost`. A template that dialed the old DSN reached whatever Postgres happened to be listening on the author's own machine and failed with an opaque TLS error; it now fails at name resolution on any conforming resolver. Treat this as a backstop rather than a guard — a resolver that hijacks NXDOMAIN can still return an address — and gate the dial on `ctx.isLocalTrace`.
