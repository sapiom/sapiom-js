# schedules

Create and manage schedules for a deployed orchestration: a recurring **cron** schedule, or a **one-off** delayed run. A schedule is attached to an orchestration by its **slug**, and each time it fires it starts a run of that orchestration with the input you set.

```ts
import { schedules } from "@sapiom/tools";

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

- **Two kinds.** `schedule_cron` takes a `cron` expression (+ optional `timezone`); `schedule_once` takes an `at` time (ISO 8601). A cron schedule fires on every matching tick until cancelled; a one-off fires exactly once.
- **Timezone-aware cron.** `timezone` is an IANA name (e.g. `"America/New_York"`); the cron is evaluated in that zone, so daylight-saving shifts are handled for you. Defaults to UTC.
- **Best-effort timing.** A schedule fires at or shortly after its scheduled time — fine for "around 9am", not for hard real-time deadlines.
- **`get` shows health.** `get(id)` returns the next scheduled fire (`nextFireAt`) and a recent fire history — each with the `executionId` of the run it started — so you can confirm a schedule is firing or debug one that isn't.
- **Cancel is final.** A cancelled schedule stops firing (a recurring one won't re-arm); recreate to reschedule.
- **Optional bounds (cron).** `startAt` / `endAt` confine when a cron schedule is active.
