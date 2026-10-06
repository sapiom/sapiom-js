---
"@sapiom/mcp": minor
---

`sapiom_dev_map` labels the map with Jev when you are signed in. Each described agent gets a `role` (intake, worker, orchestrator, reporter, monitor or utility) and each launch or event edge a `label` (hands work to, feeds data to or monitors), shown only when its probability is at least 0.8. One batched call to `jev-1.13.0` per map, and only for questions not already in `.sapiom/cache/map-labels.json`, so an unchanged map makes no call and its labels never flip. Signed out, with `platform: false`, or when Jev fails or is slow, the map says `labels: "unavailable"` and is otherwise unchanged.
