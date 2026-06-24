# memory-coding-conventions-workflow

The **workflow** version of the memory demo. The same recall → apply → learn →
verify memory loop as its two siblings, but authored as a **deployable Sapiom
orchestration** — one artifact (`index.ts`) that runs **three different ways with
no code changes**.

## What this is (and how it differs from the siblings)

| | [`memory-coding-conventions`](../memory-coding-conventions) | [`memory-coding-conventions-live`](../memory-coding-conventions-live) | **this** |
|---|---|---|---|
| Shape | orchestration | bare `main()` | orchestration |
| `index.ts` deployable? | no — `runLocal` is called inside it | n/a (not a workflow) | **yes — side-effect-free** |
| Runs locally (stub) | yes | no | yes |
| Runs against the live gateway | no | yes | yes (dev walker) |
| Runs on the Sapiom engine | no | no | **yes** |

The stub sibling is a teaching artifact whose `runLocal` call lives *inside*
`index.ts`, so that file can't be deployed. The `-live` sibling is a bare script
that hits the real gateway but isn't a workflow at all. **This** example keeps the
deployable artifact (`index.ts`) free of any top-level execution and puts the
harness in a separate `run-local.ts`, so the *same* `index.ts` is what runs
locally, what runs against the live gateway, and what the engine bundles and runs
in a Blaxel sandbox.

## The step graph

```
recall ─▶ apply ─┬─▶ learn ─▶ verify   (a new convention was recorded)
                 └─▶ skip            (the convention was already known)
```

| Step | Capability | What it does |
|------|-----------|--------------|
| `recall` (entry) | `memory.recall` | Pull prior house conventions for the repo and **inject** them into the task prompt as a numbered preamble. |
| `apply` | — (pure) | Derive the convention to record; **branch** on whether the top recalled match already covers the task (combinedScore ≥ 0.8). |
| `learn` (`canFail`) | `memory.append` | Append the new convention so the **next** run recalls it. |
| `verify` (terminal) | `memory.get` | Read the memory back to prove it persisted; terminate with the result. |
| `skip` (terminal) | — | Nothing new to record; terminate early. |

`apply` makes no capability call — it's a real branch, deterministic, so stubs can
drive **both** sides. `learn` declares `canFail` to document the seam between a
diagnosed terminal `fail()` and a throw (which the engine retries up to its cap);
this demo throws nothing and fails nowhere, but the seam is there.

## RUN MODE 1 — stub-local (offline, free, works today)

`runLocal` plays the engine and `@sapiom/tools/stub` plays the gateway. No
network, no credentials, no Sapiom account. This example resolves the
**unpublished local SDK build** via pnpm's `workspace:` protocol, so install +
build from the repo root with **pnpm** (not `npm` in this folder):

```bash
# from the repo root
pnpm install                                # links this example to the local packages
pnpm --filter='./packages/*' build          # build the local SDK (writes each package's dist/)
pnpm --filter @sapiom/example-memory-coding-conventions-workflow start
```

You'll see the per-step trace ending in a `terminate` output, with no unused
stubs and no stub warnings:

```
=== STUB MODE (offline) — scenario: learn (weak prior) ===

workflow "memory-coding-conventions-workflow" → completed

▶ recall (succeeded)
    · recalled {"count":1}
▶ apply (succeeded)
    · new convention to record {"convention":"…"}
▶ learn (succeeded)
    · appended {"id":"mem_stub_1","decision":"ADDED"}
▶ verify (succeeded)
    · verified {"id":"mem_stub_1","status":"active"}

final output: { "id": "mem_stub_1", "decision": "ADDED", "status": "active", "scope": "house-conventions" }

✓ no unused stubs, no stub warnings
```

**See the other branch** — a strong prior makes `apply` take `skip`:

```bash
DEMO_SCENARIO=skip pnpm --filter @sapiom/example-memory-coding-conventions-workflow start
```

> The committed [`.sapiom-dev/stubs.json`](./.sapiom-dev/stubs.json) is a hand-kept
> mirror of the inline default-scenario (weak-prior / learn) stub. It is the file a
> `runLocalFromDir` harness *would* load — but nothing in this example loads it:
> `pnpm start` builds the stubs inline via `buildStubs()` and calls `runLocal()`
> directly. And `sapiom orchestrations check` does **not** read it either — `check`
> only typechecks, bundles, and validates the graph/manifest; it never runs a step or
> reads stubs. So treat `stubs.json` as documentation of the canned shapes, not as
> something exercised here, and keep it in sync with `buildStubs()` by hand if you
> edit either.

## RUN MODE 2 — live-local (real LOCAL gateway; x402-paid recall/append)

Bring up the full `sapiom-local` stack first — see
`workdocs/sap785-memory/DEMO-FULL-STACK.md` in the Sapiom monorepo. Then point
this at your local memory gateway and run with `--mode live`:

```bash
SAPIOM_API_KEY=sk_your_local_key \
SAPIOM_MEMORY_URL=http://memory.services.localhost:3100 \
pnpm --filter @sapiom/example-memory-coding-conventions-workflow start:live
```

- `SAPIOM_MEMORY_URL` — the memory provider **origin** (no path; the client appends `/v1/memory/…`).
  `createClient()` takes only an `apiKey`; the memory base URL is read from this
  env var by `@sapiom/tools`, so live mode **requires** it.
- `SAPIOM_API_KEY` — a real key from your **local** backend; the account must be
  able to pay (the gateway resolves identity + payment by calling the backend).

`run-local.ts` contains a small, clearly-labeled **dev walker** that reproduces
the engine's step-walk (start at `entry`; follow `goto` / `terminate` / `fail` /
`retry` via the `isContinue` / `isTerminate` / `isFail` / `isRetry` guards) and
drives the **same** step bodies from `index.ts` against the real gateway. It is
for local dev only — in production the Sapiom engine runs these identical bodies
inside a Blaxel sandbox.

> `recall` and `append` are **x402-paid**. `get` is free. If your local stack's
> OpenRouter key is a placeholder, `append` may return **503 on embeddings** —
> that is a known external blocker of the local stack, not a bug in this example.

## RUN MODE 3 — Sapiom execution (Blaxel sandbox) against LOCAL dev infra

The **same** `index.ts` is the deployed artifact — no code changes between modes.
The control plane is the `@sapiom/cli`:

```bash
# point the CLI at your local backend (http://localhost:3000)
sapiom config set-target local

# link this workflow to a backend definition, then deploy + run
sapiom orchestrations link memory-coding-conventions-workflow --create
sapiom orchestrations deploy
sapiom orchestrations run \
  --input '{"repoSlug":"api","task":"Add a POST /users endpoint that creates a user."}' \
  --target local
sapiom orchestrations logs <executionId>
```

### Two hard caveats for LOCAL infra

1. **Capability keys are OFF by default.** The backend's
   `WORKFLOWS_INJECT_CAPABILITY_KEYS` defaults to **false**, so local capability
   steps run **tokenless** (they skip or 401). To actually exercise `memory.*`
   you must run the backend with `WORKFLOWS_INJECT_CAPABILITY_KEYS=true` **and**
   point the capability hosts at the local unified gateway, otherwise
   `@sapiom/tools` defaults to the prod `*.services.sapiom.ai` hosts and a
   locally-minted key 401s:

   ```
   WORKFLOWS_INJECT_CAPABILITY_KEYS=true
   SAPIOM_SANDBOX_URL=http://sandbox.services.localhost:3100/...
   SAPIOM_AGENTS_URL=http://agents.services.localhost:3100/...
   SAPIOM_MEMORY_URL=http://memory.services.localhost:3100
   SAPIOM_FILE_STORAGE_URL=http://files.services.localhost:3100/...
   SAPIOM_GIT_URL=http://git.services.localhost:3100/...
   ```

2. **`deploy` 404s today.** The backend deploy/link **CREATE** routes
   (`POST /definitions`, push-credentials, builds) are **not yet merged**, so
   `sapiom orchestrations deploy` (and `link --create`) return **404** for now.
   Linking to an **existing** definition works. The artifact is correct and
   deploy-ready; this is purely a server-side gap, not an issue with this example.

## How it maps onto production

In all three modes the engine/harness swaps *underneath* the step bodies, never
the bodies themselves:

- **stub-local:** `runLocal` is the engine; `@sapiom/tools/stub` is the gateway.
- **live-local:** the dev walker is the engine; the real local gateway serves
  `ctx.sapiom.memory.*`.
- **Sapiom execution:** the real engine bundles `index.ts`, mints a per-run
  scoped key, and walks the steps in a Blaxel sandbox with a real `ctx.sapiom`.
