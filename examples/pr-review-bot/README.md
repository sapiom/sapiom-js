# PR Review Bot

On a pull-request webhook, a coding agent checks out and analyzes the code,
flags any change that shipped without matching tests, and posts the review to
your email or a Slack channel — using a token you keep in the Vault.

The run **suspends at $0** while it waits for a PR, so it can sit idle for days
between reviews and cost nothing until a webhook wakes it.

## What it does

```
watch  ──(pause: wait for "pr.opened", $0 while idle)──▶  review  ──▶  assess  ─┬─▶  reportEmail  ─┬─▶  posted  (terminal)
                                                                                └─▶  reportSlack  ─┤
                                                                                                   └─▶  failed  (terminal)
```

1. **watch** — registers a PR webhook and a resume contract
   `{ executionId, signal, correlationId }`, then returns
   `pauseUntilSignal({ signal: "pr.opened", resumeStep: "review", correlationId })`.
   The run suspends here at zero cost until a PR is opened.
2. **(paused)** — nothing runs, nothing is billed, for as long as it takes.
3. **review** (resume target) — its **input IS the PR payload**. A coding agent
   (`ctx.sapiom.models.coding.run`) checks the code out in a sandbox and
   analyzes the diff, told to surface changes that lack tests. It's read-only —
   the agent reviews, it doesn't push.
4. **assess** — an LLM (`ctx.sapiom.models.run`) turns the raw findings into a
   structured review: a verdict, a summary, and the list of missing tests.
5. **reportEmail | reportSlack** — posts the review. Email uses the built-in
   `ctx.sapiom.email` capability; Slack uses a bot token you store in the Vault
   (`ctx.sapiom.vault.get`) and a direct `fetch` — nothing baked into code.

Input: `{ "repo": { "owner": "acme", "name": "api" }, "via": "email", "to": "you@example.com", "config": { "WEBHOOK_REGISTER_URL": "…" } }`.
With no `WEBHOOK_REGISTER_URL` (or `DRY_RUN` set), `watch` runs offline via its
`dryRun` guard and the report step skips the real send.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; the steps inherit
   that authority to run the coding agent, call the model, and send email.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (offline via the `dryRun` guard, free) → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real run that pauses).

## Delivering to Slack (bring your own token)

`review` and `assess` cost the same either way; only the report channel differs.
To post to Slack, set `"via": "slack"` and `"to": "#your-channel"`, then store a
[Slack bot token](https://api.slack.com/authentication/token-types#bot) in the
Vault under the ref `slack`, key `bot_token`, scoped to this workflow. The token
is read only at runtime and never lands in code. Without a token the run
degrades to a skip (it still completes) so you can trace the graph first.

## Resuming a paused run in dev

A real `run` pauses at `watch` and waits for the `pr.opened` signal. Instead of
a real webhook, fire it yourself via the MCP `signal_workflow` / `workflow_signal`
tool. The `correlationId` is the paused run's `executionId`, and the `payload`
becomes `review`'s input:

```json
{
  "signal": "pr.opened",
  "correlationId": "<executionId of the paused run>",
  "payload": {
    "repo": { "owner": "acme", "name": "api" },
    "number": 42,
    "title": "Add avatar upload endpoint",
    "branch": "feat/avatar-upload",
    "baseBranch": "main",
    "diff": "diff --git a/src/users/avatar.ts b/src/users/avatar.ts\n+export async function uploadAvatar(...) { ... }"
  }
}
```

The run wakes at `review`, the coding agent analyzes that PR, and the review is
posted through the configured channel.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
