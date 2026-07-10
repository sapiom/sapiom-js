---
"@sapiom/agent-core": patch
---

Correct stub capability path in template docs (models.coding.*); refresh offline scaffold version fallback.

- Replace stale `agent.coding.run` / `agent.coding.launch` references with the
  correct `models.coding.run` / `models.coding.launch` in all template docs
  (`templates/default/AGENTS.md`, `templates/coding-pause/AGENTS.md`,
  `templates/coding-pause/README.md`). The old path matched no stub, causing
  silent no-ops in local runs.
- Bump `VERSION_FALLBACK` in `scaffold.ts` from `{ agent: "0.1.1", tools: "0.1.1" }`
  to `{ agent: "0.6.2", tools: "0.17.1" }` to match current package versions.
  Only affects offline scaffolds (the online path still resolves npm-latest).
