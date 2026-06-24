# memory-coding-conventions

A custom Sapiom **workflow** that gives a coding agent a memory of your team's
house conventions — so it stops forgetting them on every run.

> Unlike the other examples in this folder (which call paid HTTP APIs through an
> SDK adapter), this is a **workflow** example. It runs entirely locally against
> mocked capabilities — no Sapiom account, no network, no credentials — so you
> can read it top-to-bottom and run it instantly.

## The problem

A coding agent has no memory between runs. Each time you ask it to add an
endpoint it re-derives your conventions from whatever it can see — and often
gets them wrong: a default export where you only use named ones, a request body
used without validation, a commit message that ignores your format. You fix it
in review, and next run it makes the same mistakes, because last run taught it
nothing.

## The pattern: recall → inject → append

```
recall ─▶ code ─▶ learn
```

| Step | Memory op | What it does |
|------|-----------|--------------|
| `recall` | `memory.recall` | Pull the conventions learned on prior runs and **inject** them into the agent's task prompt. |
| `code` | — | Run the coding agent on the convention-enriched task. |
| `learn` | `memory.append` | Record a new, hard-won fact so the **next** run recalls it automatically. |

The agent itself stays stateless and replaceable; the *workflow* carries the
institutional memory. `recall` is where prior knowledge enters the agent's
context; `append` is where this run's knowledge is saved for the future. Over
time the recalled set grows and the agent's first draft gets steadily closer to
house style.

### Where the injection happens

A coding run's only natural-language channel is its `task`. So "inject into the
agent context" means **composing the recalled facts into the task prompt**:

```ts
const enrichedTask = [
  baseTask,
  "",
  "Follow these house conventions (recalled from prior runs):",
  ...results.map((m) => `- ${m.content}`),
].join("\n");

await ctx.sapiom.agent.coding.run({ task: enrichedTask });
```

## Run it

This example resolves the **unpublished local SDK build** — the `memory` capability
on `@sapiom/tools` plus the `runLocal`/stub harness in `@sapiom/orchestration-core`.
Those packages reference each other through pnpm's `workspace:` protocol, which only a
pnpm **workspace** install can resolve, so this example is a workspace member and you
install it **from the repo root with pnpm** (not `npm install` in this folder):

```bash
# from the repo root
pnpm install                          # links this example to the local packages
pnpm --filter='./packages/*' build    # build the local SDK (writes each package's dist/)
pnpm --filter @sapiom/example-memory-coding-conventions start
```

> **For end users (post-publish):** the deps are `@sapiom/orchestration`,
> `@sapiom/orchestration-core`, and `@sapiom/tools` at `latest`, and a plain
> `npm install && npm start` in this folder works. The `workspace:*` deps committed
> here exist only to run against the as-yet-unpublished memory build.

You'll see the per-step trace — the conventions that were recalled and injected,
the agent's result, and the new learning that was appended:

```
=== workflow "memory-coding-conventions" → completed ===

▶ recall (succeeded)
    · recalled 3 house convention(s) {"conventions":["Validate every request body…", …]}
    · injected recalled conventions into the coding task
▶ code (succeeded)
    · coding agent finished {"status":"completed","summary":"Added POST /users…"}
▶ learn (succeeded)
    · appended a new house-convention learning {"memoryId":"stub-memory","decision":"ADDED"}

final output: { "learningId": "stub-memory", "decision": "ADDED", "summary": "Added POST /users…" }
```

> Requires a build of the Sapiom SDK that includes the `memory` capability on
> `@sapiom/tools` (and the local-run harness in `@sapiom/orchestration-core`).

## How the mock works

In production the **engine** drives the workflow and the **gateway** serves each
`ctx.sapiom.*` call. Here both are mocked:

- **`runLocal({ definition, manifest, input, stubs })`** (`@sapiom/orchestration-core`)
  plays the engine — it runs your *real* step code, in order, following the
  `goto` / `terminate` / `fail` directives your steps return.
- **Stubs** play the gateway. Each step's capability calls resolve from canned
  responses in the `stubs` object (the in-code form of `.sapiom-dev/stubs.json`),
  keyed by capability path (`"memory.recall"`, `"agent.coding.run"`, …).

The golden rule for stubs: **only stub what a step branches on.** This example
stubs `memory.recall` (its results get injected) and `agent.coding.run` (its
success gates the `learn` step). It deliberately does **not** stub
`memory.append` — nothing branches on the append result, so it falls back to the
built-in default. `runLocal` reports any stub key that matched nothing
(`unusedStubs`) or carried the wrong shape (`stubWarnings`), so typos don't pass
silently.

The step code is written exactly as it would run in production — the mock swaps
out the engine and gateway underneath it, never the workflow logic itself.

## Going further

- **Long-running agents:** await-inline `agent.coding.run` keeps this trace
  readable, but a real coding run can take minutes. Use `launch` +
  `pauseUntilSignal` so the workflow suspends instead of holding a worker — see
  the `coding-pause` template (`@sapiom/orchestration-core`).
- **Scoping memory:** this example partitions conventions per repo via the
  `scope` field. You might also scope by team, language, or service.
- **Pruning:** when a convention changes, `memory.append` auto-supersedes a
  near-duplicate (demoting the old one); to erase one outright, `memory.forget(id)`
  hard-deletes it.
