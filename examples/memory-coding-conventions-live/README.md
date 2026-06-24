# memory-coding-conventions-live

The **live** sibling of [`../memory-coding-conventions`](../memory-coding-conventions).

| | stub example | this (live) |
|---|---|---|
| Engine | `runLocal` (in-process) | real `@sapiom/tools` client |
| Gateway | `@sapiom/tools/stub` (canned) | real unified-gateway memory provider |
| Network | none | HTTP to `SAPIOM_MEMORY_URL` |
| Credentials | none | `SAPIOM_API_KEY` (sent as `x-sapiom-api-key`) |
| Cost | free | `append` is **x402-paid** ($0.002); `recall` is **not charged today** (metering deferred to an advisory/async follow-up); `get`/`forget` free |

`runLocal` is hardwired to the stub dispatcher, so there is no "live" flag on it —
hitting a real engine means using the real client directly, which is what this file does.

## Run (against the local sapiom-local stack)

Bring up the full stack first — see
`workdocs/sap785-memory/DEMO-FULL-STACK.md` in the Sapiom monorepo.

This example resolves the **unpublished local `@sapiom/tools`** (its `./memory`
capability), so it's a pnpm **workspace member**: install + build from the repo root
with pnpm (not `npm install` in this folder), then run it pointed at your local
gateway:

```bash
# from the repo root — install the workspace + build the local SDK
pnpm install
pnpm --filter='./packages/*' build

# run this example against the local memory gateway
SAPIOM_MEMORY_URL=http://memory.services.localhost:3100 \
SAPIOM_API_KEY=sk_your_local_key \
pnpm --filter @sapiom/example-memory-coding-conventions-live start
```

> **For end users (post-publish):** the dep is `@sapiom/tools` at `latest` and a plain
> `npm install` in this folder works. The `workspace:*` dep committed here exists only
> to run against the as-yet-unpublished memory build.

- `SAPIOM_MEMORY_URL` — the memory provider **origin** (no path; the client appends `/v1/memory/…`), e.g. `http://memory.services.localhost:3100`. Matches how every other `@sapiom/tools` capability takes a bare origin.
- `SAPIOM_API_KEY` — a real Sapiom API key from your **local** backend; the
  account must be able to pay (the gateway resolves identity + payment by calling
  back to the backend).

## What it does

`recall` → inject recalled conventions into a prompt → `append` a new convention →
`append` a near-duplicate (expect `SUPERSEDED`) → `append` a secret (expect
`REJECTED`) → `get` → `forget` → `forget` again (expect `204` — `forget` is
idempotent, so deleting the already-gone id succeeds, it is not a `404`).
