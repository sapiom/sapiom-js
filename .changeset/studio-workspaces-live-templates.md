---
"@sapiom/harness": patch
---

Studio: read the template gallery live, and stop pitching the product at returning users.

**Templates come from the real catalog.** `web/src/lib/templates.ts` shipped a hardcoded copy of two registry entries (pinned at harness 0.1.4 / `f0e3406`) because, as its header said, no listing API exposed the gallery to any client. One exists now, so the Studio showed 2 templates while the dashboard's Template library showed 26. New `GET /api/templates` and `GET /api/templates/:id` relay core's `GET /v1/workflows/templates{,/:id}` — the same endpoint the dashboard renders, so the two surfaces can no longer drift. The dialog gains category grouping, search, and the per-run cost estimate. Two contract details, both verified against a running backend: the core surface authenticates with `Authorization: Bearer` (the `x-sapiom-api-key` header the *agents* surface takes returns 401 here), and the path carries the `/v1` prefix. The API key stays server-side, as with the runs router; a 401/403 triggers one credential refresh and retry. Signed out or with core unreachable, the dialog falls back to the bundled offline starters **and says which** — silence is what let a two-entry list read as the whole gallery.

`estCostPerRunUsd` is null for most templates (21 of 26 today); that renders as an em dash, never `$0.00`, which would assert a genuinely free run.

The detail pane now projects the graph core actually serves — the engine's `DefinitionStepDto`/`DefinitionTransitionDto` shapes, where a step carries `stepName` and a singular `capabilityId`, edges reference steps by namespaced `id`, and terminality is a `terminate`/`fail` transition rather than a flag on the step. So a branch and a pause signal render for the first time, instead of edges inferred from array order.

**Overview is a working surface, not a pitch.** `showWelcome` was `overviewSelected || (firstRun && !hasLiveSession)`, so the first-run hero rendered whenever the Overview tab was selected — including for someone with a rail full of workspaces. The hero is now genuine-first-run only; returning users get their recent workspaces, with the Docs / Templates / New workspace action band shared by both states.

**Workspace terminology.** A workspace is a folder, matching the rail and the editor convention users arrive with: the rail header reads "Workspaces", and "New project" / "Add project" / "Project directory" become their workspace equivalents. "Agent project" is left alone deliberately — that is the SDK's own term for a `sapiom.json` directory, and `sapiom agents init` and `AGENTS.md` both use it.

**The Sample project action is gone**, along with `POST /api/sample-project` and the exported `SampleProjectSeedResponse` type (nothing else in the repo referenced either). `core/example-seed.ts` remains — `scripts/seed-example.mjs` still uses it for demo prep.
