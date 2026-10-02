# Sylon

A clone-able Slack support desk built from Sapiom agents. Customer messages in a Slack channel
become issues, a triage channel gets a card per issue, a copilot drafts replies for a human to
approve with a button, and escalations land in Linear. The agents never call each other: each one
starts from an event trigger, reads and writes one shared Postgres (`sylon`), and emits typed
`issue.*` events.

This directory is the walking skeleton (E2 of the Sylon project): the shared contracts, the
database, and two smoke agents that prove the pipe end to end. The domain agents (intake, copilot,
escalation, controller, urgent-pager) are listed in `fleet.json` and land in later changes.

## Layout

```
fleet.json            projects, triggers, connectors, example config values
fleet.local.json      your workspace's ids (gitignored; you create it)
setup.ts              pnpm run setup: create/migrate the sylon database, seed config + accounts
_shared/              inlined into every agent by the bundler (relative imports, zod/v4)
  events.ts           raw slack.* and domain issue.* schemas
  db.ts               Db interface, withDb(ctx, fn), migrations runner, pg-mem for local runs
  migrations/         001_init.sql (+ index.ts mirror; the bundler has no .sql loader)
  issues.ts           the only writer of the tables; status machine
  config.ts seed.ts   typed runtime config in the config table
  slack.ts            Slack connector methods over the tools gateway
  linear.ts           Linear MCP relay (save_issue, get_issue)
  emit.ts             events.emit wrapper + events_log
  blocks.ts           Block Kit cards + action codec (<owner>.<verb>, value = row id)
agents/<slug>/        one deployable project each (index.ts, package.json, sapiom.json)
fixtures/             { type, description, payload } per event; payload is the run input
```

## Use

```bash
pnpm install --ignore-workspace   # this directory is outside the sapiom-js workspace
pnpm test                         # vitest; pg-mem stands in for Postgres, no network
pnpm typecheck
```

`fleet.json` holds example ids (`C0CUSTOMER1`, `example-linear-team-id`, ...). Put your own
workspace's ids in `fleet.local.json` (gitignored) before setup; any key you leave out keeps the
`fleet.json` value, and setup stops if a Slack or Linear id is still an example:

```json
{
  "config": {
    "linear.team_id": "<Linear team id or key>",
    "linear.project_id": "<Linear project id>",
    "channels.triage": "<triage channel id>",
    "channels.customer": [
      { "channelId": "<customer channel id>", "accountName": "Acme" }
    ],
    "oncall.slack_id": "<Slack user id>"
  }
}
```

```bash
SAPIOM_API_KEY=<org key> pnpm run setup   # create + migrate the sylon db, seed missing config
```

`run_local` gives each execution its own in-memory database (seeded from `fleet.json`), so two
agents run locally one after another do not share issues. To follow one issue through several
agents offline, use the vitest smoke test (`agents/smoke.test.ts`), which installs one shared
database with `setLocalDb`. The deployed agents always share the `sylon` database.

Per agent: `sapiom agents link <slug> --create` (writes a gitignored `sapiom.json` pointing at
your org's agent), `sapiom agents deploy`, then attach the triggers
from `fleet.json` (`POST /v1/workflows/definitions/<slug>/triggers { kind, eventType | cron }`).
The contract every agent builds against is `plans/sylon/interfaces.md` in the Sapiom monorepo.

## Prerequisites in the target org

A Slack connector with the bot in the customer and triage channels, a Linear connector (with
`write`) discovered under the relay slug `linear`, and `@sapiom/tools` >= 0.40.0 (for
`ctx.sapiom.events.emit`).
