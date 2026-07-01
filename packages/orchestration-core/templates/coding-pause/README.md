# **PROJECT_NAME**

A Sapiom orchestration that runs a coding agent behind a **human-in-the-loop
approval that gates the publish to `main`** — authored as code against
[`@sapiom/orchestration`](https://www.npmjs.com/package/@sapiom/orchestration).

```
prepare → propose ──pause(agent.coding.result)──▶ review
   review ──pause(review.decision)──▶ decide
       decide ──reject──▶ terminate (main untouched)
       decide ──approve──pause(agent.coding.result)──▶ finalize
```

**Why two agents.** A single coding run clones, edits, commits and pushes inside
its own run — before any pause. So a naive "run then pause for approval" gate sits
_downstream_ of the push: by the time a human sees the work it has already landed
on `main`, and "reject" would mean reverting code that's already there. This
template splits the irreversible actions across two runs so the gate is _upstream_
of the one that touches `main`:

- **propose** launches agent #1 to write the change and push it to a
  **non-canonical** `proposed/<executionId>` branch — never `main`.
- **review** is resumed with agent #1's `CodingResultPayload`; it then suspends on
  the `review.decision` signal (the human approval).
- **decide** is resumed with the human decision. On **reject** (or no explicit
  approval) it terminates and `main` is left exactly as it was. On **approve** it
  launches agent #2 to promote `proposed/…` onto `main` — the **only** step that
  writes the canonical branch, reached only after approval.
- **finalize** is resumed with agent #2's result once the promotion is done.

Send the approval from your session with the dev tools' **signal** step (or the
engine's signal API): fire `review.decision` with `{ "decision": "approved" }` to
publish, or `{ "decision": "rejected" }` (or nothing) to leave `main` untouched.

State that must survive a pause goes in `ctx.shared`. A resumed step's `input`
**is** the signal payload — for a coding run that's a `CodingResultPayload`
(re-attach any live handle from it), for the human decision it's whatever the
caller sent.

`run_local` auto-resumes the human-approval pause with an **empty** payload, so a
local run takes the safe default — the **reject** branch, leaving `main`
unchanged. That's the intended smoke test: it proves the gate holds. To exercise
the **failure** branch of a coding run, stub a failed result under the _launching_
step (`propose` or `decide`) in `.sapiom-dev/stubs.json` — that value is also the
resume payload:

```jsonc
{
  "version": 1,
  "steps": {
    "propose": {
      "agent.coding.launch": {
        "status": "failed",
        "result": { "success": false },
        "error": { "stage": "run", "message": "…" },
      },
    },
  },
}
```

## Getting started

```sh
npm install
```

Then open `index.ts`. The orchestration is defined with `defineOrchestration({ steps })`; each step is a `defineStep({ name, next, run })`. The `run` body is ordinary code — and inside it, the full Sapiom tool catalog is available, pre-auth'd and tenant-scoped, on `ctx.sapiom`:

```ts
const box = await ctx.sapiom.sandboxes.create({ name: "demo" });
const repo = await ctx.sapiom.repositories.create("my-repo");
```

No credentials to wire — a per-execution tenant credential is injected when your orchestration runs.

## The loop

Author and run this orchestration with the Sapiom dev tools:

- **check** — validate locally (bundle, manifest, step graph). Offline.
- **run_local** — execute the steps locally against stubs (no real capability calls), iterating until it completes.
- **deploy** — build and ship.

`npm run typecheck` and `npm run format` are also available for editor-level checks.

See `AGENTS.md` for the full authoring loop.
