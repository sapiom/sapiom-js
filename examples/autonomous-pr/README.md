# Autonomous PR

Point this at a repo and describe the work; a coding agent picks it up, writes
the code, runs the repo's own checks, and pushes a branch carrying its own
self-review. Leave the repo unset and it provisions a small scratch repo
first, seeds a tiny examples contract, and gives itself the deterministic job
of adding one more example to it — so a zero-input run still produces
something real.

## What it does

```
plan ─▶ implement ──(pause: models.coding.result → verify)──▶ verify ─┬─▶ push ─▶ review ─▶ summary  (terminal)
                                                                       └─▶ rejected  (terminal)
```

1. **plan** — resolves the repo. Given `repoSlug`, it must already exist. Given
   none, it provisions a scratch repo (`repositories.create`).
2. **implement** — launches a coding agent (`models.coding`) on the repo; it
   clones into a fresh sandbox and does the task, never asked to run git
   itself. Coding runs are long, so the agent run **suspends at $0** and
   resumes at `verify` when it finishes. On the scratch repo, the same task
   also asks it to write a tiny `AUTHORING.md` plus two minimal examples first
   (the repo starts empty) — one coding-agent turn, not two.
3. **verify** — re-attaches that sandbox and runs `installCommand` +
   `checkCommand` over the agent's still-uncommitted changes
   (`sandboxes.exec`). A failed coding run or a red check routes to
   `rejected`; nothing is branched or pushed.
4. **push** — creates a fresh branch and pushes the changes to it
   (`repositories.pushFromSandbox`, which commits whatever is pending). This
   git host has no hosted pull-request object yet, so the pushed branch is
   the reviewable unit.
5. **review** — a second model (`models.run`) reads the diff and the coding
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

- `repoSlug` (optional) — an in-network repo to work in. Absent ⇒ a scratch
  repo is provisioned for this run.
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
   that authority to run the coding agent, attach the sandbox, and push.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (pass `{}` to
   trace the whole graph offline, free — every capability is stubbed, so the
   push always looks green) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
