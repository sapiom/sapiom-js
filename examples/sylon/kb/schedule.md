# Schedule an agent

Source: https://docs.sapiom.ai/guides/schedule

A schedule is a persisted cloud trigger attached to an already-deployed agent by its slug. Each occurrence starts an independent production run with the input object stored on the schedule.

Manage schedules through **Sapiom MCP**, either from an Agent Studio coding session or from Claude Code or Codex with Sapiom MCP connected. Authenticate the MCP connection before using its authoring tools; schedule operations additionally read and change tenant-scoped cloud state.

Before scheduling, [deploy the agent](/guides/deploy) and confirm it has a `ready` build. Sapiom can store a trigger independently of a build, but a fire cannot start the agent without a runnable build.

> **Caution: Runtime input is not a trigger.**
> Passing a field named `schedule` to an agent run does not create a schedule. Some gallery agents carry that field into their output as a cadence label. Create the persisted trigger with one of the operations on this page.

## Preview recurring times

Preview validates a five-field cron expression and IANA timezone and projects upcoming occurrences. It creates no trigger, but it still requires authentication because it reads the tenant-scoped scheduling service.

Ask Claude Code or Codex to preview this cadence before creating it:

> Using Sapiom MCP, preview the next three occurrences of `0 9 * * 1-5` in `America/Los_Angeles`.

For an exact tool request, `sapiom_dev_agents_cron_preview` accepts:

```json
{
  "cron": "0 9 * * 1-5",
  "timezone": "America/Los_Angeles",
  "count": 3
}
```

The response echoes the cron and timezone and returns `occurrences` as ISO 8601 instants in UTC. Omitted timezone defaults to UTC, and omitted count defaults to five. Preview does not apply a schedule's optional bounds or jitter.

## Create a recurring schedule

Ask your coding agent to create a recurring schedule for the deployed agent. For example:

> Schedule the deployed `daily-research-brief` agent for 9:00 AM every weekday in `America/Los_Angeles`. Pass `{ "topic": "agent reliability" }`, skip occurrences missed during downtime, and show me the next fire time before you finish.

The corresponding `sapiom_dev_agents_schedule` input is:

```json
{
  "definition": "daily-research-brief",
  "kind": "schedule_cron",
  "cron": "0 9 * * 1-5",
  "timezone": "America/Los_Angeles",
  "input": { "topic": "agent reliability" },
  "policy": { "catchupPolicy": "skip", "overlapPolicy": "allow" }
}
```

The cron is evaluated in `timezone`. Optional `startAt` and `endAt` ISO timestamps bound the recurring window. `catchupPolicy: "skip"` drops missed slots after downtime; `"all"` replays them one at a time until caught up. `jitterMs` can spread a fleet's starts by a deterministic offset of up to one hour. Overlapping runs are currently allowed, so the only accepted `overlapPolicy` is `"allow"`.

Schedule timing is best effort. A due occurrence starts at or shortly after its recorded time; do not use it as a hard real-time clock.

## Create a one-off schedule

A one-off stores one future fire and completes after it starts that run:

```json
{
  "definition": "daily-research-brief",
  "kind": "schedule_once",
  "at": "<future-ISO-8601-timestamp>",
  "input": { "topic": "launch readiness" }
}
```

Ask your coding agent to replace the placeholder and create a one-off schedule with that object. `at` must be a future ISO 8601 timestamp; the schedule input must be a JSON object accepted by the agent's entry schema when the run starts.

## Inspect schedule state and fires

1. **List an agent's schedules**

   Call `sapiom_dev_agents_schedule_inspect` with the definition slug:

   ```json
   { "definition": "daily-research-brief" }
   ```

   Each summary includes `id`, `kind`, `status`, `cron`, `timezone`, and `nextFireAt`.

2. **Inspect one schedule**

   ```json
   { "scheduleId": "<schedule-id>" }
   ```

   Detail adds the stored input, bounds, policy, and `recentFires`. Each fire record has its scheduled time, state, `firedAt` terminalization time, and the production `executionId` it started (or an error when it could not start one). A cancelled pending occurrence becomes `skipped`, so it has a `firedAt` timestamp but no execution ID.

3. **Follow a fired run**

   Copy a non-null `recentFires[].executionId` into `sapiom_dev_agents_inspect`, or open that execution under the agent's **Runs** page. The Agents dashboard observes scheduled executions like other production runs; it does not provide a schedule editor or schedule list.

## Cancel future occurrences

Call `sapiom_dev_agents_schedule_cancel`:

```json
{ "scheduleId": "<schedule-id>" }
```

Cancellation returns status `disabled`, marks a pending future occurrence `skipped`, and prevents a recurring schedule from re-arming. It does not cancel a run that already started. Cancellation is final; create a new schedule to reschedule.

## Do not confuse schedules with delayed child dispatch

| Operation                                               | Ownership                     | What happens later                     | Parent behavior                                                                           |
| ------------------------------------------------------- | ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Schedule created through Sapiom MCP                     | Post-deployment cloud trigger | Starts an independent run of the agent | No parent is linked or resumed                                                            |
| `ctx.sapiom.agents.launch({ at })` inside an agent step | Runtime parent/child dispatch | Starts one linked child run at `at`    | Returns a pause-only handle; the child's terminal result automatically resumes the parent |

Delayed child dispatch stores parent lineage and an internal `trigger-<id>` correlation. Use its returned handle with `pauseUntilSignal`; do not recreate that correlation with an independent schedule.

- [Use signals](https://docs.sapiom.ai/guides/use-signals): Declare a durable pause and deliver a human or webhook payload to the matching waiter.
- [Inspect a run](https://docs.sapiom.ai/guides/inspect): Read the production execution started by a schedule fire.
