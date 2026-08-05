---
"@sapiom/harness": minor
---

Studio now emits agent-lifecycle product events to PostHog, so the build →
templates → deploy funnel is measurable.

- `agent.created` — a new agent came into existence (a fresh `sapiom.json`
  appeared in the workspace registry), deduped by path and seeded on first load
  so pre-existing agents are never counted. This is the "agents built" metric —
  confirmed existence, not the click that kicked off scaffolding.
- `agent.template_cloned` — a template was used to start an agent, carrying the
  template slug and the on-ramp surface. The "templates used" metric.
- `agent.deploy_started` / `agent.deploy_succeeded` (with duration) /
  `agent.deploy_failed` (coarse `error_kind` enum) — the "agents deployed"
  metric, fired from the deploy stream.

Payloads carry ids / enums / counts / durations only — never prompt text, file
contents, or absolute paths. Capture stays gated by the existing
product-analytics consent tiers and is disabled under mock/e2e.
