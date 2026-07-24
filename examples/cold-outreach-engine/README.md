# Cold Outreach Personalization Engine

Enrich a lead list with Hunter, scrape each company site, write a personalized
first line for every prospect, verify deliverability, then drip touches with
durable, $0 waits between them — stopping the moment someone replies.

## What it does

```
enrich ──▶ scrape ──▶ personalize ──▶ verify ──▶ launch ──▶ send ⇄ advance ──▶ done
(Hunter)   (web)      (models.run)     (Hunter)   (database)  (email)          (terminal)
```

1. **enrich** — for each lead (`{ domain, company?, fullName? }`), resolve a real
   contact with Hunter: `findEmail` when you name the person, `domainSearch` to
   surface a decision-maker when you only have the company. Per-lead failures are
   skipped, never fatal.
2. **scrape** — read each unique company site (`ctx.sapiom.search.scrape`) for a
   few lines of context. Bodies are bounded and die at the next step — they never
   enter shared state.
3. **personalize** — hand the snippets to the live model
   (`ctx.sapiom.models.run`) for one concrete opener per prospect, falling back to
   a safe generic line when the model returns nothing usable.
4. **verify** — check each address for deliverability
   (`ctx.sapiom.search.emailSearch.verifyEmail`) and drop the ones that would
   bounce before anything sends.
5. **launch** — persist the campaign roster to a Postgres store the engine owns
   (`ctx.sapiom.database`), then start the drip. A `dryRun` stops here and returns
   the full plan — every opener — without sending or persisting.
6. **send** — deliver the current touch to everyone still active
   (`ctx.sapiom.email`), log it, then **pause at $0** until the drip interval
   elapses or a reply lands.
7. **advance** — wakes on that reply-or-timeout, marks anyone who replied as done,
   and either loops back for the next touch or ends the run.

Input: `{ "leads": [{ "domain": "acme.com", "fullName": "Jordan Rivera" }], "senderName": "Dana", "dripIntervalDays": 3, "dryRun": true }`.

- `leads` supplies the list; a `domain` is enough, a `fullName` sharpens the match.
- `sequence` overrides the default three touches; `senderName` signs the mail.
- `dripIntervalDays` sets the gap between touches (default 3).
- `dryRun: true` returns the plan and openers without sending, persisting, or waiting.

### The durable wait

Between touches the run suspends via `pauseUntilSignal` with a timeout: it costs
nothing while idle, resumes on its own when the interval passes, and
short-circuits the instant a `reply.received` signal arrives — so a prospect who
answers never gets the next follow-up.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call its metered capability.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (capabilities
   stubbed; pass `dryRun: true` so the send, DB, and drip are skipped, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (a real, billed run that enriches, personalizes, verifies, and sends).

4. To end the drip early when a prospect replies, fire the `reply.received`
   signal with the `workflow_signal` MCP tool, passing `{ "email": "..." }` and
   the run's `executionId` as the `correlationId`. To run it on a cadence, attach
   the `schedule` as a cron trigger on the deployed agent.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
