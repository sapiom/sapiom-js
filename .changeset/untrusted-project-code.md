---
"@sapiom/mcp": minor
"@sapiom/agent-core": patch
"@sapiom/harness": patch
---

Ask before running a project's own code.

- `sapiom_dev_map` reads a project's code without running it by default. Pass `steps: true` to draw each agent's steps, which imports and runs the agents' code (`agents check`). Without it, each agent reads `stepsUnavailable: "steps not requested"`. `describeProject` follows the same default: `steps: true` opts in.
- Scaffolding accepts only the names of the bundled templates, so `sapiom_dev_agents_scaffold` and agent-core's `scaffold` reject any other template name with `UNKNOWN_TEMPLATE`.
- Studio no longer marks a project as trusted for Claude Code when the project is added or a session starts. Before a Claude Code session starts in an untrusted project, it asks **Trust this folder?**. **Not now** starts the session and leaves the prompt to Claude Code.
