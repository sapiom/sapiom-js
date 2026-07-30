# Deploy links (or creates) the remote agent when the project isn't linked yet

Date: 2026-07-30
Status: approved, ready for implementation plan

## The bug

Apply a gallery template, click **Deploy**, and nothing ships. The button is live —
it is only auth-gated — but the request always fails.

`clone()` writes `sapiom.json` with the fork provenance and no `definitionId`
(`packages/agent-core/src/clone.ts:202`):

```js
...(definitionId ? { definitionId } : { forkId: resolvedForkId }),
```

That is deliberate. `packages/agent-core/src/config.ts:17` documents the intent:

> Absent right after a template `clone` (the definition is created at `deploy`, D6)
> and filled in by `link`.

**The "created at `deploy`" half was never built.** So:

1. The SPA routes the `deploy` macro to the direct server action, not the pty
   (`web/src/lib/macro-actions.ts`).
2. `POST /api/workflows/:id/deploy` reads the config
   (`src/server/actions.ts:401`) and gets `null`.
3. The route answers **409 `"workflow is not linked to a Sapiom agent"`**
   (`src/server/actions.ts:402-407`).

The Deploy button carries no `needsDeploy` gate (`web/src/components/SessionStepsBar.tsx:114-123`),
so a fresh template offers a button that cannot succeed. `sapiom agents deploy`
fails the same way, via `requireConfig()` → `NOT_LINKED`.

The missing mechanism already exists: `link({ name, create: true })`
(`packages/agent-core/src/link.ts`) lists `/definitions`, matches on name **or**
slug, and only `POST /definitions` when nothing matched. That single call is both
halves of what we need — resync to an existing remote agent, or create one.

## Scope

The harness deploy route only. The CLI and the agent-facing MCP deploy tool keep
their current `NOT_LINKED` behaviour and their existing remedy
(`sapiom agents link --create`); a scripted or CI deploy must not silently create
a remote agent because it ran in the wrong directory.

`agent-core`'s `deploy()` is not touched. It deliberately never writes
`sapiom.json` — `link` is the only config writer — and that separation stays.

## Design

### Flow

```
POST /api/workflows/:id/deploy
  400 id missing · 503 not signed in · 404 unknown workflow      [unchanged]

  config = readDefinitionId(workflow.path)
  ├─ bad-config → 409 "sapiom.json is not valid JSON"            [new]
  ├─ linked     → straight to the build, no link call            [unchanged]
  └─ unlinked   → commit 200 + NDJSON headers, then:
         name = await resolveDefinitionName(workflow)
         write { phase: "linking", name }
         result = link({ name, create: true })
         writeConfig(workflow.path, { definitionId: result.definitionId,
                                      name: result.name })

  write { phase: "building", definitionId }
  deploy({ projectDir, definitionId }) → terminal ready | error
```

`link()` matching by name/slug before creating is what makes this "resync **or**
create": re-deploying never duplicates an agent, and a template already deployed
from another machine re-attaches to the existing definition instead of forking
the user's cloud state.

`writeConfig()` merges over the existing file (`agent-core/src/config.ts:70`), so
the clone's `forkId`, `templateId`, `repoFullName` and `defaultBranch` all
survive the write.

Both the `link` and the `deploy` call go through the existing
`withKeyRefreshRetry` helper, so a rejected key refreshes and retries once — the
same recovery the build already gets.

### Bad config must not create an orphan

`readDefinitionId` currently swallows an unparseable `sapiom.json` as `null`
(`src/server/actions.ts:267`, deliberately: "treat as not linked"). Under
auto-link that becomes a defect — we would create a remote definition and only
then fail, because `writeConfig` calls `readConfig`, which throws `BAD_CONFIG` on
invalid JSON. The remote agent would exist with nothing recording it.

So the helper returns a three-way result:

```ts
type ConfigState =
  | { kind: "linked"; definitionId: string }
  | { kind: "unlinked" }
  | { kind: "bad-config" };
```

`bad-config` keeps a 409, with a message naming the real problem. No remote
resource is created on a path that cannot record it.

### Name of the created agent

Fallback chain, first hit wins:

1. **`graph.manifestName`** — the agent's own `defineAgent({ name })`, read via
   `extractWorkflowGraphCached(path)` (`src/core/canvas-cache.ts`). Usually a
   cache hit, because the canvas renders on bind. This is the name the codebase
   already treats as authoritative: the registry stores it as `definitionSlug`
   (`src/core/workflow-registry.ts:31`) and `config.ts:22` calls `sapiom.json`'s
   `name` a cache of it.
2. **`sapiom.json`'s `name`** — present for a project a previous `link` touched.
3. **The registry name** — `package.json`'s `name`, else the folder basename
   (`workflow-registry.ts:51-62`).

Step 1 fails cheaply and silently when extraction cannot run (no `node_modules`
yet, a bundle error), which is exactly when steps 2 and 3 apply.

The name written back to `sapiom.json` is `link()`'s **returned** `name`, not the
requested one — the server may normalize it, and the CLI's `link` command already
caches the returned value (`cli/src/commands/agents/link.ts:28`). The `linking`
stream line carries the requested name, since it is emitted before the call.

Steps 1-3 live behind `resolveDefinitionName`, which is optional: when a host
does not supply it the router falls back to steps 2 and 3 only (config name, then
`ActionWorkflow.name`). That keeps the router's default free of any canvas
dependency, and `src/server/index.ts` supplies the manifest-name implementation.

### Seams

The actions router reaches neither the registry nor the canvas today, and that
does not change:

| Where | Addition |
| --- | --- |
| `ActionsCoreDeps` | `link`, `writeConfig` — so no test touches network or fs |
| `ActionsRouterOpts` | `resolveDefinitionName?: (w: ActionWorkflow) => Promise<string>` |
| `ActionWorkflow` | `name: string` — the registry already carries it |
| `src/server/index.ts:1174` | wires `resolveDefinitionName` to the canvas cache |

### Stream shape

`DeployStreamEvent` gains one non-terminal line:

```ts
| { phase: "linking"; name: string }
```

Emitted only on the unlinked path, before the `link` call. The union's mirror in
`web/src/lib/api.ts` gains the same member, and `use-harness-state.ts`'s deploy
handler gives it its own toast ("Creating the agent on Sapiom…") alongside the
existing `building` toast. Terminal lines are unchanged: still exactly one
`ready` or `error`.

### Errors

A link failure ends the stream with one terminal `error` line carrying its own
code — never disguised as a build failure, and `deploy()` is never called.
`toDeployErrorEvent` already maps an `AgentOperationError` to `{ code, message,
hint }`, so a `NOT_FOUND`/`HTTP_*`/`NETWORK` from `link` surfaces as-is.

**Known risk:** `cli/src/commands/agents/link.ts:12` records that the `--create`
backend route (`POST /definitions`) was parallel work that may not have landed.
If it 404s, the user sees a named failure with a hint instead of today's opaque
409 — better, but the button will not fully work until that route is live. This
is a backend dependency, not something this change can resolve. Verify against a
real tenant before calling the feature done.

### Desktop host

No new packaging hazard (`packages/harness/CLAUDE.md`): `link` is a plain network
call, and the only subprocess involved is the existing `runManifestCheck`, which
already translates asar paths and sets `ELECTRON_RUN_AS_NODE`. Nothing new needs
`asarUnpack`, and `smoke.ts` needs no new check.

## Tests

TDD — each test written and seen failing before the code that satisfies it.

`src/server/actions.test.ts` (fakes for `link` / `writeConfig` / `deploy`):

- unlinked project → stream is `linking` → `building` → `ready`; `link` called
  once with `{ name, create: true }`; `definitionId` written to `sapiom.json`
  with `forkId` and `templateId` preserved.
- already-linked project → `link` never called, stream unchanged. Regression
  guard for the common path.
- `link` rejects → exactly one terminal `error` line with the operation's code;
  `deploy` never called; nothing written.
- unparseable `sapiom.json` → 409, `link` never called, no write.
- rejected key on the `link` call → refresh + retry once, then proceed.
- name resolution: manifest name wins; falls back to config name; falls back to
  the registry name.

`web/src/lib/api.test.ts` + the deploy handler: a `linking` line parses and sets
its own toast without disturbing the terminal-event contract.

Plus a changeset (patch, `@sapiom/harness`).

## Out of scope, deliberately

`sapiom agents init` writes no `sapiom.json` at all, so a scaffolded
(non-gallery) project is never discovered by the registry
(`workflow-registry.ts:43` scans for that marker) and therefore never gets a
Deploy button to click. That is a separate bug with a separate fix; it is not
addressed here.
