# Autonomous PR

Point this at a repo and describe the work; a coding agent picks it up, writes
the code, runs the repo's own checks, deploys a live preview of the branch,
and pushes it carrying its own self-review. Leave the repo unset and it opens
(or, the first time, provisions) Sapiom's own persistent demo repo, the same
one every zero-input run reuses, and gives itself the deterministic job of
adding one more example to it.

## What it does

```
plan ─▶ implement ──(pause: models.coding.result → verify)──▶ verify ─┬─▶ push ─▶ preview ─▶ review ─▶ summary  (terminal)
                                                                       └─▶ rejected  (terminal)
```

1. **plan** — resolves the repo through the same injection seam the demo
   database uses (`resolveResourceHandle`, key `repoSlug`). A named repo must
   already exist. With none named, it opens (or provisions, the first time) a
   persistent demo repo (`autonomous-pr-demo`, `repositories.get` /
   `.create`) reused across every run instead of recreated.
2. **implement** — launches a coding agent (`models.coding`) on the repo; it
   clones into a fresh sandbox and does the task, never asked to run git
   itself. Coding runs are long, so the agent run **suspends at $0** and
   resumes at `verify` when it finishes. Only the run that actually
   provisions the demo repo also seeds a tiny `AUTHORING.md` plus two minimal
   examples first, in the same coding turn as the task; every later run
   against that same repo finds the seed already there.
3. **verify** — re-attaches that sandbox, confirms the checkout's real
   directory, and runs `installCommand` + `checkCommand` over the agent's
   still-uncommitted changes (`sandboxes.exec`). A failed coding run or a red
   check routes to `rejected`; nothing is branched, previewed, or pushed.
4. **push** — creates a fresh branch, writes a small deterministic static
   gallery server into the checkout, and pushes it all
   (`repositories.pushFromSandbox`, which commits whatever is pending). This
   git host has no hosted pull-request object yet, so the pushed branch is
   the reviewable unit.
5. **preview** — deploys a live preview of that branch
   (`sandboxes.deployPreview`, `source: { kind: "git" }`) so you can look at
   the actual result, not just a diff. A failed deploy degrades honestly
   (`previewStatus`, `previewUrl: null`) rather than failing an otherwise
   green, already-pushed run.
6. **review** — a second model (`llm.run`) reads the diff and the coding
   agent's own notes and writes a short self-review: a verdict, a summary,
   and what it would flag.

## Inputs

```json
{
  "repoSlug": "my-app",
  "task": "Add a health check endpoint and a matching test.",
  "installCommand": "npm install",
  "checkCommand": "npm test"
}
```

- `repoSlug` (optional) — an in-network repo to work in. Absent ⇒ Sapiom's
  persistent demo repo is opened (or provisioned, the first time) instead.
- `task` — plain-words instruction for the coding agent (default: add an
  example following `AUTHORING.md`).
- `installCommand` / `checkCommand` — how to install and check the checkout
  (defaults `npm install` / `npm run typecheck`, matching this repo's own
  authoring lifecycle).

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit
   that authority to run the coding agent, attach the sandbox, deploy the
   preview, and push.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (pass `{}` to
   trace the whole graph offline, free — every capability is stubbed, so the
   push and the preview always look green) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`.

## Files

- `index.ts` — the agent (edit this).
- `seed.ts` — exact seed file content for the demo repo's first use.
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
