# The Brain

A **fleet orchestrator** — a meta-workflow that coordinates a fleet of child
workflows. The flagship "agents managing agents" template.

A fleet is a handful of independent `@sapiom/agent` workflows (its _members_),
each firing on its own cron and doing its own job. Nothing watches the _whole_:
no one notices when a daily member silently missed today, or a weekly member is
past its cadence, or a launch never reported back. The members are limbs with no
cortex. The brain is the cortex — it **consumes the fleet's events, reasons about
the whole picture, and launches the right member**, never doing irreversible work
itself.

The key idea: deterministic code senses and acts, a constrained LLM only
_chooses_ from a fixed allow-list, and every irreversible action is guard-railed.

## What it does

```
scan ──▶ assess ──▶ actuate ──▶ report  (terminal)

scan     read the event bus + fold the log into cadence/idempotency facts;
         compute deterministic situations (no_child_ran_today, cooldown_due,
         stale_no_result). The event log IS the memory; a cursor tracks "new".
assess   hand the situations to models.run with a FIXED allow-list of plays;
         re-validate the JSON against the allow-list (deterministic fallback).
actuate  execute the plan behind six guardrails; launch each due member as a
         child workflow with an idempotency key; append a member.launched row.
report   post a briefing to a low-noise channel, append a brain.briefing row,
         advance the cursor, terminate.
```

1. **scan** — reads its own event bus (a Postgres DB the brain owns via
   `ctx.sapiom.database`), folds `member.launched` / `member.result` rows into
   per-member cadence facts, and computes crisp **situations**:
   - `no_child_ran_today` — a daily member has no run recorded today.
   - `cooldown_due` — a periodic member is past its cadence.
   - `stale_no_result` — a launch never reported a result and aged past
     `staleHours`.
2. **assess** — hands the situations to `ctx.sapiom.models.run` with a system
   prompt that permits **only** a fixed allow-list of plays: `launch_member`,
   `escalate_to_human`, `no_action`. `parsePlan()` re-validates every play/target
   against the allow-list and falls back to a deterministic plan on bad JSON.
3. **actuate** — executes the plan deterministically behind **six guardrails**
   (allow-list re-check, drop `no_action`, escalate-only, only-surfaced-targets,
   per-day cooldown, single-open, fan-out cap). Each launch carries an idempotency
   key `<play>-<target>-<yyyy-mm-dd>` and appends a `member.launched` row.
4. **report** — posts a briefing (raw Slack + vault token), appends a
   `brain.briefing` row, advances the cursor, terminates.

## The fleet

The fleet is a list of members, defaulted in `DEFAULT_FLEET` and overridable
per-run via the `fleet` input:

```json
{
  "fleet": [
    {
      "id": "daily-greeter",
      "label": "Daily greeter",
      "slug": "hello-agent",
      "cadenceHours": 24,
      "dueHourUtc": 12,
      "input": { "name": "fleet (daily)" }
    },
    {
      "id": "weekly-greeter",
      "label": "Weekly greeter",
      "slug": "hello-agent",
      "cadenceHours": 168,
      "input": { "name": "fleet (weekly)" }
    }
  ]
}
```

Each member's `slug` is the **child definition** the brain launches. The default
fleet uses [`hello-agent`](../hello-agent/) as a trivial, deployable stand-in — a
`cadenceHours <= 24` member surfaces `no_child_ran_today`, a `> 24` member
surfaces `cooldown_due`. Swap the slugs for your real fleet.

## Two known platform gaps (the template copies them, not fights them)

- **`ctx.sapiom.agents.launch` 404s on the deployed backend today.** Children are
  launched by a raw `POST https://api.sapiom.ai/v1/workflows/executions` with body
  `{ definitionId, input, idempotencyKey }` and header `x-api-key`, resolving
  slug→definitionId from a cached `/definitions` list plus a static fallback map
  (`DEF_IDS` in `index.ts`). **Migrate to `agents.launch` if/when it is fixed.**
- **definitionIds are environment-specific** — a child's definitionId does not
  exist until it is deployed. **Deploy your child workflows first** (e.g.
  `hello-agent`), capture each definitionId, and seed it into `DEF_IDS`. The live
  `/definitions` lookup will also resolve them if it lists them; `launchChild`
  throws a clear error if a slug still can't be resolved.

## Offline tracing & safe rollout

- **`dryRun`** — `run_local` with `{ "dryRun": true }` traces the full
  `scan → assess → actuate → report` graph: raw Postgres / Slack / child-launch
  I/O is skipped, while the real `models.run` call still runs. With no API key,
  `launchChild` returns a synthetic execution id.
- **`observeOnly`** — do everything real (read the bus, post the briefing) but
  **launch nothing**; the briefing shows what it WOULD launch. Run a live cron in
  observe-only for a few days to calibrate before switching actuation on.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; `scan`/`assess`/
   `actuate`/`report` inherit that authority to read the DB handle, call
   `models.run`, read the vault, and launch children.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local`
   (pass `{ "dryRun": true }` to trace the loop offline, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (pass `{ "observeOnly": true }` first to report without launching, then run
   with actuation on).

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `template.json` — gallery detail (manifest v1).
- `AGENTS.md` — the authoring loop.

Run `npm run typecheck` to confirm it compiles.
