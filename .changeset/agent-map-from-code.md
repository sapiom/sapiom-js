---
"@sapiom/mcp": minor
"@sapiom/harness": patch
---

`@sapiom/mcp` adds `sapiom_dev_map`. It computes the agent map from code on every call and stores nothing. You can pass a project folder, optionally with a git `ref`, or your own description of agents.

- **Systems** are agents joined by code-proven calls, events and timers. Each edge carries the file and line that proves it.
- **Shared resources** (vault keys, databases, connectors) show on each agent that uses them and never join two agents into a system.
- **Steps** come from `agents check`.
- **Triggers and deploy state** come from the signed-in account.

The source scan Studio's agent Canvas uses now lives in `@sapiom/mcp/map`, and `@sapiom/harness` imports it from there. The Canvas behaves the same.
