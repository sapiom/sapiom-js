# Dependency Upgrade

A scheduled "Dependabot triage" that only opens a PR when the build is green. A
coding agent bumps a repo's dependencies in a sandbox, the real test suite runs
there, a model risk-assesses the diff, and it pushes only when the tests pass and
the risk is within your bar.

## What it does

```
plan ─▶ bump ──(pause: models.coding.result → verify)──▶ verify ─┬─▶ assess ─┬─▶ publish  (terminal)
                                                                 │           └─▶ held     (terminal)
                                                                 └─▶ rejected (terminal)
```

1. **plan** — resolves the repo slug and the install/test commands, and validates
   the input. No `repoSlug` → straight to `rejected`.
2. **bump** — launches a coding agent (`models.coding`) on the repo; it clones
   into a fresh sandbox at `/workspace/<slug>` and bumps the dependencies. Coding
   runs are long, so the workflow **suspends at $0** and resumes at `verify` when
   the run finishes.
3. **verify** — re-attaches the coding run's sandbox, runs `git diff --stat`, then
   installs and runs the test suite (`sandboxes.exec`). A failed coding run, a
   failed install, or a non-zero test exit all route to `rejected`.
4. **assess** — a model (`models.run`) rates the upgrade `low`/`medium`/`high`
   from the dependency diff. Above `maxAutoRisk` (default `medium`) → `held`.
5. **publish** — pushes the bumped branch from the sandbox and archives the
   triage report. **held** / **rejected** archive the report but never push.

Every outcome writes a markdown triage report to file storage
(`fileStorage.upload`) — a durable record of what changed and why it shipped or
didn't.

## Inputs

```json
{
  "repoSlug": "my-app",
  "task": "Upgrade dependencies to latest compatible versions and update the lockfile.",
  "installCommand": "npm install",
  "testCommand": "npm test",
  "workingDirectory": "my-app",
  "maxAutoRisk": "medium",
  "allowRisky": false,
  "dryRun": false,
  "schedule": "0 6 * * 1"
}
```

- `repoSlug` (required) — an in-network repo the coding agent clones and upgrades.
- `installCommand` / `testCommand` — how to build and test the checkout (defaults
  `npm install` / `npm test`).
- `workingDirectory` — the checkout subdirectory to run tests in, relative to the
  sandbox workspace (default: the repo slug).
- `maxAutoRisk` — `low` \| `medium` \| `high`; risk above this is held for a human.
  Set `allowRisky: true` to push anyway.
- `dryRun` — assemble everything but skip the push and the report upload, so a
  local run makes no network calls.
- `schedule` — documentation for the cron cadence; the trigger carries the real
  schedule when you deploy.

## The dry-run guard

The push is the one irreversible action, so it (and the report upload) are gated
on `dryRun`. With `dryRun: true`, `verify` synthesizes a green result when no real
sandbox is present, so `run_local` traces `plan → bump → verify → assess →
publish` end to end — free, with nothing pushed.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit
   that authority to run the coding agent, attach the sandbox, and archive the
   report.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (pass `{ "repoSlug": "my-app", "dryRun": true }` to trace the whole graph
   offline, free) → `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run` (a real upgrade + test + push).

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
