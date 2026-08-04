# schedules

Create and manage schedules for a deployed orchestration: a recurring **cron** schedule, or a **one-off** delayed run. A schedule is attached to an orchestration by its **slug**, and each time it fires it starts a run of that orchestration with the input you set.

```ts
import { schedules } from "@sapiom/tools";

// Validate the cadence first. This does not create a schedule.
const preview = await schedules.preview({
  cron: "0 9 * * 1-5",
  timezone: "America/New_York",
  count: 3,
});

// Recurring: run "enrich-lead" at 9am New York time, Monday–Friday.
const daily = await schedules.create({
  definition: "enrich-lead",
  kind: "schedule_cron",
  cron: "0 9 * * 1-5",
  timezone: "America/New_York",
  input: { source: "crm" },
});

// One-off: run once, two hours from now.
await schedules.create({
  definition: "send-receipt",
  kind: "schedule_once",
  at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  input: { orderId },
});
```

```ts
// List an orchestration's schedules, inspect one, or cancel it.
const all = await schedules.list("enrich-lead");
const one = await schedules.get(all[0].id); // includes nextFireAt + recent fires
await schedules.cancel(one.id);
```

## Things to know

- **Two kinds.** `schedule_cron` takes a `cron` expression (+ optional `timezone`); `schedule_once` takes an `at` time (a `Date` or ISO 8601 string). A cron schedule fires on matching ticks until it is cancelled or reaches `endAt`; a one-off fires once unless it is cancelled first.
- **Timezone-aware cron.** `timezone` is an IANA name (e.g. `"America/New_York"`); the cron is evaluated in that zone, so daylight-saving shifts are handled for you. Defaults to UTC.
- **Preview is non-persistent.** `schedules.preview(...)` validates cron + timezone and returns projected occurrences. It still uses the authenticated agents API.
- **Best-effort timing.** A schedule fires at or shortly after its scheduled time — fine for "around 9am", not for hard real-time deadlines.
- **`get` shows health.** `get(id)` returns the next scheduled fire (`nextFireAt`) and a recent fire history — each with the `executionId` of the run it started — so you can confirm a schedule is firing or debug one that isn't.
- **Cancel affects future work.** A cancelled schedule drops future unfired occurrences (a recurring one won't re-arm). It does not cancel a run that already started; recreate the schedule to reschedule.
- **Optional bounds (cron).** `startAt` / `endAt` confine when a cron schedule is active.
- **Standalone schedules are not delayed child dispatch.** `schedules.create(...)` starts independent runs. `agents.launch({ at })` is the separate parent/child primitive: it schedules one child and returns a handle the parent can pause on.
