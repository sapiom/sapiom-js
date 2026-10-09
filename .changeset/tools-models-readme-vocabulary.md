---
"@sapiom/tools": patch
---

Docs: the `models` README was titled `# agent` and showed `agent.coding.run`, an export that does not exist. It is now titled `# models`, uses `models.coding.run` / `models.coding.launch`, and documents `models.run` as the managed loop (prompt, optional `system`, remote `mcps` as its tools, `model` omitted so the platform routes the run). The package README's namespace table now lists `models` and `agents` (it listed `agent` and `orchestrations`, which link to directories that do not exist), and the repositories, schedules and content-generation READMEs use "agent" and "run" in place of "orchestration" and "workflow".
