---
"@sapiom/orchestration-core": patch
"@sapiom/tools": patch
"@sapiom/cli": patch
"@sapiom/mcp": patch
---

Add schedules: run a deployed orchestration on a recurring cron schedule or once at a set time.

- `@sapiom/orchestration-core`: `createSchedule`, `listSchedules`, `getSchedule`, `cancelSchedule`, and `previewCron`.
- `@sapiom/tools`: a `schedules` namespace (`create`, `list`, `get`, `cancel`).
- `@sapiom/cli`: `sapiom orchestrations schedule create | list | inspect | cancel | preview`.
- `@sapiom/mcp`: schedule tools — create, inspect (list/detail + recent fires), cancel, and cron preview.
